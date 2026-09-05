using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Web.Script.Serialization;

// Native SCM adapter only. The TypeScript Supervisor owns all Bridge lifecycle decisions.
public sealed class BridgeServiceHost : ServiceBase {
    private readonly Dictionary<string, object> plan;
    private Process child;
    private IntPtr job;
    private StreamWriter log;
    private volatile bool stopping;
    public BridgeServiceHost(Dictionary<string, object> configuration) {
        plan = configuration;
        ServiceName = (string)plan["name"];
        CanStop = true;
        CanShutdown = true;
        AutoLog = false;
    }
    protected override void OnStart(string[] ignored) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException("service_job_create_failed");
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new InvalidOperationException("service_job_limit_failed");
        log = new StreamWriter((string)plan["logPath"], true) { AutoFlush = true };
        string arguments = Quote((string)plan["entry"]) + " supervisor run --service-stdin yes --config " + Quote((string)plan["configPath"]);
        if (plan["endpoint"] != null) arguments += " --endpoint " + Quote((string)plan["endpoint"]);
        child = new Process { StartInfo = new ProcessStartInfo((string)plan["node"], arguments) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        }, EnableRaisingEvents = true };
        child.StartInfo.EnvironmentVariables["PATH"] = (string)plan["runtimePath"];
        child.OutputDataReceived += (sender, data) => {
            if (data.Data != null && data.Data.Length <= 16384) lock (this) { if (log != null) log.WriteLine(data.Data); }
        };
        // The CLI already emits content-free operational JSON to stdout. Discard raw stderr.
        child.ErrorDataReceived += (sender, data) => {};
        child.Exited += (sender, args) => { if (!stopping) { CloseJob(); Environment.Exit(1); } };
        if (!child.Start()) throw new InvalidOperationException("service_child_start_failed");
        if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(); CloseJob(); throw new InvalidOperationException("service_job_assign_failed"); }
        child.StandardInput.WriteLine("start");
        child.StandardInput.Flush();
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
    }
    protected override void OnStop() { StopChild(true); }
    protected override void OnShutdown() { StopChild(false); }
    private void StopChild(bool extendStopDeadline) {
        stopping = true;
        if (child != null && !child.HasExited) {
            int remaining = Convert.ToInt32(plan["stopTimeoutMs"]);
            if (extendStopDeadline) RequestAdditionalTime(remaining + 5000);
            try { child.StandardInput.WriteLine("stop"); child.StandardInput.Flush(); } catch (IOException) {}
            if (!child.WaitForExit(remaining)) CloseJob();
        }
        CloseJob();
        lock (this) { if (log != null) { log.Dispose(); log = null; } }
    }
    private void CloseJob() { IntPtr value = System.Threading.Interlocked.Exchange(ref job, IntPtr.Zero); if (value != IntPtr.Zero) CloseHandle(value); }
    private static string Quote(string value) {
        var result = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '\"' ? slashes * 2 + 1 : slashes);
            result.Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('\"').ToString();
    }
    public static void Main() {
        string path = Path.ChangeExtension(System.Reflection.Assembly.GetExecutingAssembly().Location, ".json");
        var configuration = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
        ServiceBase.Run(new BridgeServiceHost(configuration));
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
        public long ProcessTime, JobTime; public uint LimitFlags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr handle, int type, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
