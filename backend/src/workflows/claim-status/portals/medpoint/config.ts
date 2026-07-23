import type { PortalConfig } from "../../types";

export const medpointConfig: PortalConfig & {
  defaultLoginUrl: string;
  selectors: {
    username: string;
    password: string;
    signIn: string;
    recaptcha: string;
    otpInput: string;
    otpValidate: string;
    currentIpa: string;
    claimsMenu: string;
    searchAction: string;
    memberLastName: string;
    memberFirstName: string;
    serviceFromDate: string;
    serviceToDate: string;
    claimLink: string;
  };
} = {
  id: "medpoint",
  name: "Medpoint Portal",
  defaultLoginUrl: "https://portal.medpointmanagement.com/",
  runtime: {
    supportsLocal: true,
    supportsDeployed: false,
    requiresVpn: false,
  },
  selectors: {
    username: 'input[formcontrolname="username"]',
    password: 'input[formcontrolname="password"]',
    signIn: 'button:has-text("Sign in"), [role="button"]:has-text("Sign in"), .mat-button-wrapper:has-text("Sign in")',
    recaptcha: '.recaptcha-checkbox-checkmark, iframe[title*="reCAPTCHA" i], iframe[src*="recaptcha" i]',
    otpInput: 'input[name="otp"], input[aria-label="Enter OTP"]',
    otpValidate: 'button:has-text("Validate OTP"), button:has-text("Validate"), [role="button"]:has-text("Validate OTP"), [role="button"]:has-text("Validate")',
    currentIpa: 'span.ng-tns-c8-2.ng-star-inserted',
    claimsMenu: 'a:has-text("Claims"), button:has-text("Claims")',
    searchAction: 'button:has-text("Search"), [role="button"]:has-text("Search"), button:has(mat-icon:has-text("search")), .mat-icon:has-text("search")',
    memberLastName: 'input[formcontrolname="membLast"]',
    memberFirstName: 'input[formcontrolname="membFirst"]',
    serviceFromDate: 'input[formcontrolname="serviceFromDate"]',
    serviceToDate: 'input[formcontrolname="serviceToDate"]',
    claimLink: 'a[href*="/claims/"]',
  },
};
