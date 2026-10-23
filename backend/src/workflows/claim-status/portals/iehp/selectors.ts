export const IEHP_SELECTORS = {
  auth: {
    signedInIndicators: [
      "li[ng-click='logOut()']",
      ".headerTopNav_signout",
      "text=/Sign\\s*Out/i",
      "text=/Eligibility/i",
      "text=/Welcome/i",
      "text=/My\\s*account/i",
    ],
    loginFailed: "text=/Login ID or Password entered is incorrect\\. Please re-enter and try again\\.(?:\\s*Attempts Remaining:\\s*\\d+)?/i",
    otpInput: "input[autocomplete='one-time-code']:visible, input[name*='otp' i]:visible, input[id*='otp' i]:visible, input[name*='verificationCode' i]:visible, input[id*='verificationCode' i]:visible, input[name*='securityCode' i]:visible, input[id*='securityCode' i]:visible, input[placeholder*='verification code' i]:visible, input[placeholder*='security code' i]:visible, input[placeholder*='one-time' i]:visible",
    otpPrompt: "text=/verification code|one.time (?:code|password)|security code|enter the code (?:sent|we sent)/i",
    otpGenericInput: "input[name='code' i]:visible, input[id='code' i]:visible, input[placeholder*='code' i]:visible",
    otpSubmit: "button:has-text('Verify'):visible, button:has-text('Confirm'):visible, button:has-text('Continue'):visible, button:has-text('Submit'):visible, input[type='submit']:visible",
    otpRejected: "text=/(?:invalid|incorrect|expired).{0,40}code|code.{0,40}(?:invalid|incorrect|expired)|verification (?:failed|unsuccessful)/i",
  },
  common: {
    financeToggle: "a[ng-click*='vm.toggle.FIN']",
    searchInput: "input#search, input[placeholder*='Check Number']",
    searchButton: ".singleSearchButton, button[type='submit']",
    resultRow: "tr.line-item",
    downloadIcon: ".fa-arrow-circle-down",
    noRecords: "text=/No records found\\./i",
    fullScreenLoader: "div[full-screen-ajax-loader] .full-screen-bg",
  },
  claimRa: {
    link: "a[ui-sref='finance.remittance'], a[href*='/finance/remittance-advice'], a:has-text('Claims RAs')",
    reset: ".accordionPane:has(.search-again), h2.search-again",
    resultCheckCell: "tr.line-item td:nth-child(3)",
    download: "div[ng-click*='GetRaPdfDownload']",
    downloadFallback: "div[uib-popover*='download Claim PDF'], .fa-arrow-circle-down",
  },
  coveredRa: {
    link: "a[ui-sref='finance.covered']",
    reset: "div[uib-popover='Reset search'], .close-btn[uib-popover*='Reset search']",
  },
} as const;
