export { WhatsAppChannelAdapter } from "./whatsapp-adapter.js";
export { normalizeWhatsAppMessage } from "./whatsapp-adapter.js";
export {
  activateBaileysAuthGeneration,
  createStagedBaileysAuthState,
  discardBaileysAuthGeneration,
  openActiveBaileysAuthState,
  openBaileysAuthState
} from "./baileys-auth-state.js";
export { pairWhatsAppAccount } from "./whatsapp-pairing.js";
export type {
  WhatsAppPairingMaterial,
  WhatsAppPairingOptions,
  WhatsAppPairingResult,
  WhatsAppPairingSocket,
  WhatsAppPairingSocketFactory
} from "./whatsapp-pairing.js";
export type {
  AdapterSocket,
  BaileysSocketConfiguration,
  BaileysSocketFactory,
  WhatsAppAdapterReadiness,
  WhatsAppChannelAdapterOptions,
  WhatsAppInboundMessage
} from "./whatsapp-adapter.js";
export type {
  BaileysAuthStateHandle,
  BaileysAuthGenerationHandle,
  BaileysAuthGenerationRootOptions,
  OpenBaileysAuthStateOptions
} from "./baileys-auth-state.js";
