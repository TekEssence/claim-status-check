export const BCBS_AVAILITY_ELIGIBILITY_SELECTORS = {
  navigation: {
    patientRegistration: "text=\"Patient Registration\"",
    eligibilityInquiry: "a:has-text('Eligibility and Benefits Inquiry'), button:has-text('Eligibility and Benefits Inquiry'), [role='menuitem']:has-text('Eligibility and Benefits Inquiry')",
  },
  payerSelection: {
    payer: "#payerId-field",
    provider: "#provider",
  },
  inquiryForm: {
    providerType: "input[aria-required='true'][role='combobox']",
    memberId: "input[name='memberId']",
    patientLastName: "input[name='patientLastName'], input[aria-label='Patient Last Name']",
    patientFirstName: "input[name='patientFirstName'], input[aria-label='Patient First Name']",
    birthMonth: "[role='spinbutton'][aria-label='Month']",
    birthDay: "[role='spinbutton'][aria-label='Day']",
    birthYear: "[role='spinbutton'][aria-label='Year']",
    dismissTips: "button[aria-label^='Dismiss ']:has-text('Got it!')",
    placeOfService: "#placeOfService-field",
    serviceType: "#serviceType",
    submit: "button[type='submit']:has-text('Submit')",
  },
  results: {
    memberStatusLabel: "div:has-text('Member Status')",
    currentPlanEffectiveDateLabel: "text='Current Plan Effective Date'",
    additionalPayerHeading: "text='Other or Additional Payer Information'",
    relationshipToSubscriberLabel: "text='Relationship to Subscriber'",
    insuranceTypeLabel: "text='Insurance Type:'",
    planProductLabel: "text='Plan / Product:'",
    filterByNetworkLabel: "text='FILTER BY NETWORK'",
    newRequest: "button:has-text('New Request')",
  },
} as const;