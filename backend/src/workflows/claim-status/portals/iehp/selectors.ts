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
