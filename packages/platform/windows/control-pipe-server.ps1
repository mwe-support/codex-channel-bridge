param(
  [Parameter(Mandatory = $true)]
  [string]$PipeName
)

$source = @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class BridgeControlPipe
{
    private const int MaxRequestBytes = 262144;
    private const int MaxInstances = 16;
    private static readonly ConcurrentDictionary<int, NamedPipeServerStream> Connections =
        new ConcurrentDictionary<int, NamedPipeServerStream>();
    private static readonly object Gate = new object();
    private static readonly object OutputGate = new object();
    private static readonly AutoResetEvent SlotAvailable = new AutoResetEvent(false);
    private static NamedPipeServerStream acceptor;
    private static volatile bool stopping;
    private static int nextConnectionId;

    public static void Run(string pipeName)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        bool created;
        var mutex = new Mutex(true, MutexName(pipeName), out created);
        if (!created) { mutex.Dispose(); throw new IOException("pipe_already_in_use"); }
        var input = new Thread(ReadCommands) { IsBackground = true };
        input.Start();
        try
        {
            var first = true;
            while (!stopping)
            {
                while (!stopping && Connections.Count >= MaxInstances - 1) SlotAvailable.WaitOne();
                if (stopping) break;
                var pipe = CreatePipe(pipeName);
                lock (Gate)
                {
                    if (stopping) { pipe.Dispose(); break; }
                    acceptor = pipe;
                }
                if (first) { Emit("READY"); first = false; }
                try { pipe.WaitForConnection(); }
                catch (ObjectDisposedException) { pipe.Dispose(); if (stopping) break; throw; }
                lock (Gate) { if (ReferenceEquals(acceptor, pipe)) acceptor = null; }
                if (stopping) { pipe.Dispose(); break; }
                var id = Interlocked.Increment(ref nextConnectionId);
                Connections[id] = pipe;
                ThreadPool.QueueUserWorkItem(_ => ReadRequest(id, pipe));
            }
        }
        finally
        {
            Stop();
            try { mutex.ReleaseMutex(); } catch { }
            mutex.Dispose();
        }
    }

    private static string MutexName(string pipeName)
    {
        using (var sha = SHA256.Create())
            return "Local\\CodexChannelBridgeControl-" +
                BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(pipeName))).Replace("-", "");
    }

    private static NamedPipeServerStream CreatePipe(string pipeName)
    {
        var current = WindowsIdentity.GetCurrent().User;
        if (current == null) throw new InvalidOperationException("service_identity_unavailable");
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(current);
        AddFullControl(security, current);
        AddFullControl(security, system);
        AddFullControl(security, administrators);
        var pipe = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            MaxInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            4096,
            4096,
            security
        );
        VerifyAcl(pipe, current, system, administrators);
        return pipe;
    }

    private static void AddFullControl(PipeSecurity security, SecurityIdentifier sid)
    {
        security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
    }

    private static void VerifyAcl(
        NamedPipeServerStream pipe,
        SecurityIdentifier current,
        SecurityIdentifier system,
        SecurityIdentifier administrators)
    {
        var foundCurrent = false;
        var foundSystem = false;
        var foundAdministrators = false;
        foreach (PipeAccessRule rule in pipe.GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (rule.AccessControlType != AccessControlType.Allow ||
                (!sid.Equals(current) && !sid.Equals(system) && !sid.Equals(administrators)))
                throw new UnauthorizedAccessException("unexpected_pipe_acl");
            foundCurrent |= sid.Equals(current);
            foundSystem |= sid.Equals(system);
            foundAdministrators |= sid.Equals(administrators);
        }
        if (!foundCurrent || !foundSystem || !foundAdministrators)
            throw new UnauthorizedAccessException("incomplete_pipe_acl");
    }

    private static void ReadRequest(int id, NamedPipeServerStream pipe)
    {
        var handedOff = false;
        try
        {
            using (var bytes = new MemoryStream())
            {
                for (;;)
                {
                    var value = pipe.ReadByte();
                    if (value < 0) return;
                    if (value == '\n') break;
                    if (bytes.Length >= MaxRequestBytes) return;
                    bytes.WriteByte((byte)value);
                }
                Emit("REQUEST\t" + id + "\t" + Convert.ToBase64String(bytes.ToArray()));
                handedOff = true;
            }
        }
        catch (IOException) { Close(id); }
        catch (ObjectDisposedException) { Close(id); }
        finally { if (!handedOff) Close(id); }
    }

    private static void ReadCommands()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line == "STOP") { Stop(); return; }
            var parts = line.Split(new[] { '\t' }, 4);
            int id;
            NamedPipeServerStream pipe;
            if (parts.Length != 4 || parts[0] != "WRITE" || !Int32.TryParse(parts[1], out id) ||
                !Connections.TryGetValue(id, out pipe)) continue;
            try
            {
                var bytes = Convert.FromBase64String(parts[3]);
                pipe.Write(bytes, 0, bytes.Length);
                pipe.Flush();
                if (parts[2] == "1") Close(id);
            }
            catch (FormatException) { Close(id); }
            catch (IOException) { Close(id); }
            catch (ObjectDisposedException) { Close(id); }
        }
        Stop();
    }

    private static void Close(int id)
    {
        NamedPipeServerStream pipe;
        if (!Connections.TryRemove(id, out pipe)) return;
        try { pipe.Dispose(); } catch { }
        SlotAvailable.Set();
    }

    private static void Stop()
    {
        if (stopping) return;
        stopping = true;
        lock (Gate) { try { if (acceptor != null) acceptor.Dispose(); } catch { } }
        foreach (var id in Connections.Keys) Close(id);
        SlotAvailable.Set();
    }

    private static void Emit(string value)
    {
        lock (OutputGate) { Console.WriteLine(value); Console.Out.Flush(); }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  [BridgeControlPipe]::Run($PipeName)
} catch {
  if ($_.Exception.GetBaseException().Message -eq "pipe_already_in_use") {
    [Console]::Out.WriteLine(("ERROR" + [char]9 + "pipe_already_in_use"))
  }
  [Console]::Error.WriteLine("windows_control_pipe_failed:{0}", $_.Exception.GetType().Name)
  exit 1
}
