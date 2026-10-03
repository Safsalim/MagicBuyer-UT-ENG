export const futbinErrorMessage = (result) => {
  const openTab = "Open futbin.com in the same browser profile, keep the tab open with MagicBuyer enabled in Violentmonkey/Tampermonkey, then test again.";
  if (result.verification) return `FUTBIN returned a verification page. ${openTab} Complete verification if it appears.`;
  if (result.status === 429) return "FUTBIN is rate limiting requests (429). Wait a few minutes before testing again.";
  if (result.status === 403) return `FUTBIN denied the script's request (403); the homepage may still work normally. ${openTab}`;
  if (result.status === 503) return "FUTBIN is temporarily unavailable (503). Try again later.";
  if (result.blocked) return `FUTBIN rejected the requested page. ${openTab}`;
  return `The FUTBIN request failed${result.status ? ` (${result.status})` : " (network error or userscript access denied)"}. ${openTab}`;
};
