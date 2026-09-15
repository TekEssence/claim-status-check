import type { AvailityProjectConfig } from "./types";

export const medRevenueAvailityConfig: AvailityProjectConfig = {
  id: "medrevenue",
  inquiryMode: "member-search",
  requireInputProjectColumn: false,
  provider: "Alkhouri, Wadie",
  providerNpi: "1568556652",
  state: "California",
  // Add confirmed portal payer names here; never change the Minimax registry.
  payers: {
    molina: {
      portalPayerName: "MOLINA HEALTHCARE CALIFORNIA",
      insuranceNameAliases: ["Molina", "Molina Healthcare", "Molina Healthcare California"],
    },
  },
  selectors: {
    patientRegistration: "#patient_registration-menu",
    eligibilityInquiry: '[title="Eligibility and Benefits Inquiry"]',
    memberSearch: '[role="tab"]:text-is("Member Search")',
    memberId: 'input[name="msMemberId"]',
    state: "#msStateCode",
    memberPanel: '#member-search-panel, [role="tabpanel"]:visible',
    search: 'button:text-is("Search")',
    memberRows: 'tbody tr, [role="rowgroup"] [role="row"]',
    submit: 'button:text-is("Submit")',
    dateGroups: '.MuiPickersSectionList-root',
    coverage: '.MuiChip-label',
  },
  selectorFallbacks: {
    dateGroups: '[contenteditable="false"]:has([role="spinbutton"][aria-label="Month"])',
  },
};
