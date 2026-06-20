export const aerialConfig = {
  id: "aerial",
  name: "Aerial Claim Status",
  claimsPath: "claimInfo.asp",
  selectors: {
    username: "input#txtUserName[name='txtUserName']",
    password: "input#txtPassword[name='txtPassword']",
    loginSubmit: "input#imgbtnPgSubmit[type='button']",
    claimsLink: "a[title='Claims'][href='claimInfo.asp']",
  },
  runtime: {
    supportsLocal: true,
    supportsDeployed: true,
    requiresVpn: false,
  },
};
