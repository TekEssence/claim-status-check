export const optumProConfig = {
  id: "optum-pro",
  name: "Optum Pro Claim Status",
  defaultLoginUrl: "https://pro.optum.com",
  selectors: {
    username: "#username",
    usernameSubmit: "#btnLogin",
    password: "#login-pwd",
    passwordSubmit: "#btnLogin",
    usernameError: "#notificationMessage, .notification-message, [role='alert'], .alert, .error, #vr_username",
    verifyOptions: "#rbaOptions",
    textMessageOption: "#textMsg",
    otpInput: "#otpBox",
    otpSubmit: "#continuebtn",
    pageTitle: "#page-title",
  },
  runtime: {
    supportsLocal: true,
    supportsDeployed: true,
    requiresVpn: false,
  },
};
