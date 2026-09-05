export const cignaConfig = {
  id: "cigna",
  name: "Cigna Claim Status",
  defaultLoginUrl: "https://www.cignaforhcp.com/app/login",
  claimSearchUrl: "https://cignaforhcp.cigna.com/app/claim/search",
  selectors: {
    cookieClose: [
      "#onetrust-close-btn-container button",
      ".onetrust-close-btn-handler",
      "button[aria-label*='close' i]",
      "button:has-text('×')",
    ].join(", "),
    homeLoginButton: "[data-test-id='login-submit-button']",
    username: "#username",
    usernameNext: "button[data-action-button-primary='true']",
    password: "#password",
    passwordContinue: "button[data-action-button-primary='true']",
    // Verify Identity / OTP screen
    otpBodyHint: "verify your identity",
    otpInput: "#code",
    otpContinue: "button[data-action-button-primary='true']",
    otpResend: "button[value='resend-code']",
    // Best-effort signal that a submitted OTP was rejected. Cigna's exact
    // wording/markup for this hasn't been confirmed against a live "wrong
    // code" screen - adjust this regex/selector if the real error message
    // differs once seen in practice.
    otpErrorMessage: "text=/invalid.*code|incorrect.*code|code.*incorrect|code.*expired|expired.*code/i",
    // Present on every authenticated page (top-right "Logout" link in every
    // screenshot so far) - used both to confirm a login/OTP attempt
    // succeeded and to detect a mid-run session logout.
    loggedInIndicator: "text=/Logout/i",
    // Claim search page
    claimSearchHeading: "text=/Claims search/i",
    // The 4 patient search-type radios. We only ever use idName ("Name/Cigna patient ID").
    searchTypeIdName: "#idName, [data-test-id='idName']",
    firstName: "#firstName, [data-test-id='patient-firstName']",
    lastName: "#lastName, [data-test-id='patient-lastName']",
    memberId: "#memberId, [data-test-id='patient-memberId']",
    searchButton: "[data-test-id='patient-search-button']",
    clearAll: "[data-test-id='reset']",
    // The "Claim Search" link at the top of the claim detail page
    // (breadcrumb-0 = "Claim Search", breadcrumb-1 = current claim number).
    // Text-based fallback included in case the data-test-id is ever
    // missing/renamed - "Claim Search" (this link) never collides with the
    // top nav's "Search Claims" dropdown item, which uses different word
    // order.
    claimSearchBreadcrumb: "[data-test-id='breadcrumb-0'], a:text-is('Claim Search')",
    // Results table
    resultsTable: "[data-test-id='claims-threesixty-search-result-table']",
    resultsBody: "[data-test-id='claims-threesixty-search-result-table-content']",
    noResultsMessage: "[data-test-id='no-results-message']",
  },
  timing: {
    postLoginMs: 1500,
    postSearchMs: 3500,
    detailLoadMs: 2500,
    betweenRowsMs: 300,
    mfaWaitMs: 180000,
    otpValidationMs: 30000,
    otpTypedWaitMs: 120000,
  },
  runtime: {
    supportsLocal: true,
    supportsDeployed: false,
    requiresVpn: true,
  },
};
