// Twilio Voice identities permit alphanumeric characters and underscores only.
export const voiceIdentity = (clientId: string, actorId: string) =>
  `crm_${clientId.replaceAll("-", "")}_${actorId.replaceAll("-", "")}`.toLowerCase();
