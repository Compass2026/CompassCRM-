// The provider contract for Compass Communications (0063). Twilio is the only
// implementation (./twilio.ts); the functions depend on these shapes, so a
// second provider would implement them rather than change the callers.
//
// Two credential scopes, never mixed:
//   ParentCredential      Compass's parent account and its MAIN API key. Used
//                         only to manage subaccounts: create / read one, and
//                         mint the subaccount's own API key.
//   SubaccountCredential  A client's subaccount and an API key that lives IN
//                         that subaccount. Everything that concerns the client
//                         (numbers, Messaging Service, messages, compliance
//                         reads) runs with this one.

export type ParentCredential = { scope: "parent"; accountSid: string; keySid: string; keySecret: string };
export type SubaccountCredential = { scope: "subaccount"; accountSid: string; keySid: string; keySecret: string };

export type Subaccount = { sid: string; friendlyName: string | null; status: string; ownerAccountSid: string | null };
// authToken / secret are returned once by the provider and go straight to
// Vault; callers never log or return them.
export type CreatedSubaccount = Subaccount & { authToken: string };
export type SubaccountWithToken = Subaccount & { authToken: string | null };
export type CreatedKey = { sid: string; secret: string };

export type AvailableNumber = {
  phoneNumber: string;
  friendlyName: string | null;
  sms: boolean;
  voice: boolean;
  mms: boolean;
};

export type ProviderNumber = {
  sid: string;
  phoneNumber: string;
  friendlyName: string | null;
  sms: boolean;
  voice: boolean;
  mms: boolean;
  accountSid: string;
};

export type MessagingService = { sid: string; friendlyName: string };

export type SendResult = { sid: string; status: string; errorCode: string | null; errorMessage: string | null };

export type Registration = {
  sid: string;
  rawStatus: string | null;
  rejectionCode: string | null;
  rejectionReason: string | null;
  editAllowed: boolean | null;
  submittedAt: string | null;
};

export interface ProvisioningProvider {
  // Reads the parent account with the parent key; only a Main key may read
  // /Accounts, so this doubles as the "is it a Main key" check.
  fetchParentAccount(parent: ParentCredential): Promise<Subaccount>;
  createSubaccount(parent: ParentCredential, friendlyName: string): Promise<CreatedSubaccount>;
  fetchSubaccount(parent: ParentCredential, subaccountSid: string): Promise<SubaccountWithToken>;
  createSubaccountKey(parent: ParentCredential, subaccountSid: string, friendlyName: string): Promise<CreatedKey>;
}

export interface MessagingProvider {
  searchTollFree(sub: SubaccountCredential, opts: { areaCode?: string; limit: number }): Promise<AvailableNumber[]>;
  purchaseNumber(sub: SubaccountCredential, phoneNumber: string, friendlyName: string): Promise<ProviderNumber>;
  fetchNumber(sub: SubaccountCredential, numberSid: string): Promise<ProviderNumber>;
  createMessagingService(sub: SubaccountCredential, opts: {
    friendlyName: string; inboundUrl: string; statusCallbackUrl: string; useCase: string;
  }): Promise<MessagingService>;
  addNumberToService(sub: SubaccountCredential, serviceSid: string, numberSid: string): Promise<void>;
  sendMessage(sub: SubaccountCredential, opts: {
    messagingServiceSid: string; to: string; body: string; statusCallbackUrl: string;
  }): Promise<SendResult>;
  fetchTollFreeVerification(sub: SubaccountCredential, sid: string): Promise<Registration>;
  fetchCustomerProfile(sub: SubaccountCredential, sid: string): Promise<Registration>;
}

// A provider refusal: HTTP status plus the provider's own error code and
// message (never a credential).
export class ProviderError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
  }
}
