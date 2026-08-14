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
    otpInput: [
      'input[name="otp"]',
      'input[aria-label="Enter OTP"]',
      'input[placeholder*="Enter OTP" i]',
      'input[placeholder*="OTP" i]',
      'input[formcontrolname*="otp" i]',
      'input[name*="otp" i]',
    ].join(', '),
    otpValidate: [
      'button:has-text("Validate OTP")',
      'button:has-text("Validate")',
      '[role="button"]:has-text("Validate OTP")',
      '[role="button"]:has-text("Validate")',
      '.mat-mdc-raised-button:has-text("Validate OTP")',
      '.mat-mdc-unelevated-button:has-text("Validate OTP")',
      '.mat-button-wrapper:has-text("Validate OTP")',
    ].join(', '),
    currentIpa: [
      'span.ng-tns-c8-2.ng-star-inserted',
      '[class*="ipa"]',
      '[class*="IPA"]',
      '[data-testid*="ipa"]',
      '[data-test*="ipa"]',
      'mat-select[formcontrolname*="ipa" i]',
      'mat-form-field:has-text("IPA")',
    ].join(', '),
    claimsMenu: [
      'a:has-text("Claims")',
      'button:has-text("Claims")',
      '[role="link"]:has-text("Claims")',
      '[role="button"]:has-text("Claims")',
      'a[href*="claim" i]',
      'button[routerlink*="claim" i]',
      'a[routerlink*="claim" i]',
      '[mattooltip*="claim" i]',
    ].join(', '),
    searchAction: [
      'button:has-text("Search")',
      '[role="button"]:has-text("Search")',
      'button[type="submit"]',
      'button:has(mat-icon:has-text("search"))',
      'button mat-icon:has-text("search")',
      '.mat-icon:has-text("search")',
      '[aria-label*="search" i]',
    ].join(', '),
    memberLastName: 'input[formcontrolname="membLast"], input[formcontrolname*="last" i], input[name*="last" i], input[placeholder*="last" i]',
    memberFirstName: 'input[formcontrolname="membFirst"], input[formcontrolname*="first" i], input[name*="first" i], input[placeholder*="first" i]',
    serviceFromDate: 'input[formcontrolname="serviceFromDate"], input[formcontrolname*="from" i], input[name*="from" i], input[placeholder*="from" i]',
    serviceToDate: 'input[formcontrolname="serviceToDate"], input[formcontrolname*="to" i], input[name*="to" i], input[placeholder*="to" i]',
    claimLink: 'a[href*="/claims/"], a[href*="claim" i], a:has-text("Claim #"), a:has-text("Claim"), [role="link"]:has-text("Claim")',
  },
};
