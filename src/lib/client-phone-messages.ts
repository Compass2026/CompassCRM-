// What the client workspace says for each code the client-phone Edge
// Function answers (supabase/functions/client-phone/handler.ts). Pure, so
// tests/client-phone-messages.test.mjs can check every code has words.
export const phoneReasons: Record<string, string> = {
  forbidden: "Your account cannot access this workspace.",
  voice_not_ready:
    "Browser calling isn't set up for this business line yet. Ask your Compass team, or call from your own phone.",
  no_lead_phone:
    "This lead didn't give a valid phone number, so there is no one to call. Reply by email instead.",
  verification_required: "Texting is awaiting carrier verification.",
  save_draft_first: "Save this draft before sending.",
  send_uncertain_refresh_first:
    "An earlier text to this lead isn't confirmed yet. Try again in a minute; Compass checks it first and never sends it twice.",
  send_uncertain:
    "Compass couldn't confirm this text yet. Press Check status in a minute; it won't be sent twice.",
  send_network:
    "Compass didn't answer. Press Check status to find out whether the text went; it won't be sent twice.",
  not_sent: "This text was not sent. Press Send to try again.",
  provider_refused:
    "The carrier refused this text. Check the number with the lead, or call or email instead.",
  invalid_request: "Refresh the lead and try again.",
  no_consent:
    "This lead hasn't given permission to be texted. Ask them by phone or email, and have your Compass team record it.",
  opted_out:
    "This lead texted STOP. Only they can opt back in, by texting START to this number.",
  outbound_disabled: "Text sending has not been enabled.",
  not_enabled: "Texting isn't turned on for this business yet.",
  no_phone:
    "This lead didn't give a valid mobile number, so they can't be texted. Call or email instead.",
  lead_contact_mismatch:
    "This lead's number isn't linked to its contact yet, so the text was not sent. Ask your Compass team to repair the lead.",
  no_number: "This business has no texting number set up yet.",
  no_messaging_service:
    "The business number isn't ready to send texts yet. Ask your Compass team.",
  empty: "Write a message before sending.",
  too_long: "A text can be at most 1,600 characters.",
  send_not_ready: "The text could not be sent. Refresh the lead and try again.",
  inquiry_not_found: "This lead could not be found. Refresh the page.",
  invalid_draft: "A text can be at most 1,600 characters.",
  rate_limited: "Please wait a minute and try again.",
};
