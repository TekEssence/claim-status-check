# Claim Status manual and service input preparation

`POST /service/jobs` with `workflow: "CLAIM_STATUS"` prepares the workbooks consumed by the existing portal workers. Service preparation now uses those workers' input readers and credential routing functions to validate the generated files. Aliases, combined patient names, optional claim fields, login defaults, and group routing therefore follow the existing portal behavior.

The reviewed portal identifiers are `aerial`, `all-care`, `astrona`, `availity`, `blue-shield`, `cigna`, `iehp`, `kaiser`, `medpoint`, `my-family`, `optum-pro`, `physicians`, `regal`, `uhc`, and `waystar`.

## Account settings

All service requests still supply account `username` and `password`. Supply `login_url` wherever the existing workbook reader requires it. Readers that already provide a default URL retain that default when the value is omitted. In particular, Kaiser deliberately uses its configured fresh login URL, as it does for manual uploads.

The following optional settings are carried into the existing login workbook fields:

| Portal | Credential fields |
| --- | --- |
| Aerial | `group`, `subportal`, `claims_url`, `success_url_fragment` |
| Blue Shield | `group`, `claim_status_url`, `mfa_mailbox`, `mail_configuration` |
| Waystar | `login_url`, `provider_id`, `provider_name`, `service_type_code`, `verification_answers` |
| IEHP | `claim_status_url` |
| Availity | `totp_secret` (required), `success_url_fragment` |
| Regal | `preferred_email`, `preferred_phone`, `preferred_phone_suffix`, `verification_method` |

Regal email verification accepts these optional keys on the existing `credentials`
object (the required `login_url`, `username`, and `password` are unchanged):

```json
{ "verification_method": "email", "preferred_email": "person@example.com" }
```

The corresponding login Excel columns are **Verification Method** and
**Preferred Email**. The aliases `verification_method` and `preferred_email`
are also accepted in Excel; column names and matching are case-insensitive.
Service JSON uses the exact snake_case keys above.

Only one enabled Email option compatible with the full preferred address is
auto-selected. `*` and bullet masks can hide multiple characters; visible local
and domain characters must still match. Duplicate matches, fully hidden
mailboxes, invalid/missing preferred addresses, and conflicting phone/email
preferences without an explicit method use the existing manual-selection flow.
`preferred_email` alone may select a unique match if no phone preference is set.
SMS/call preferences and runtime OTP entry are unchanged. Logs contain only
generic selection/fallback messages, never the supplied address or OTP.

Deploy the API and push the worker image for this addition. No frontend change
or database migration is required.

Waystar `verification_answers` is an array of `{ "question": "...", "answer": "..." }` entries. These become the existing Verification sheet, scoped to the supplied username.

Blue Shield `mail_configuration` is an object using only the existing `MAIL_CONFIGURATION_KEYS` exported by its input reader. It becomes the MailConfigurations sheet; the API does not apply those values to its own process environment.

`credentials.accounts` can supply multiple accounts for Aerial, All Care, Astrona, and Blue Shield, which already route accounts by group or payer. Other portals currently read a single login account; their service adapters reject multiple accounts rather than silently selecting the first. Submit separate jobs for those accounts. Single-account group/payer fields can be inferred when all submitted claims resolve to one native group/payer.

## Runtime and project settings

* Aerial resolves `projectId` through its existing subportal resolver, including `PMG` and `Citrus Valley`; the default remains PMG. Group-scoped credentials follow the native reader for either subportal.
* UHC loads the existing provider mapping workbook in the backend for both submission methods. Its worker and IEHP's worker read claim rows from the uploaded workbook. Frontend JSON rows remain a legacy fallback when no workbook is supplied.
* Blue Shield uses its existing fresh-run checkpoint defaults. Regal service jobs start at row zero; cancellation and retries continue using the existing service lifecycle. Existing executions are not resumed by changing their frozen inputs.
* Availity continues loading built-in project and provider configuration in the backend. An optional top-level `selection_rules` array can represent the same rows as a manual Charm selection-rules upload. The generated file is parsed by the existing manual rule reader. This option is rejected for other projects.

Example optional Charm rule:

```json
{
  "selection_rules": [
    {
      "Practice": "Dummy Practice",
      "Organization to select": "Dummy Organization",
      "Provider Mode": "groupNameOnly",
      "Tab to use": "HIPAA Standard"
    }
  ]
}
```

## Verification and runtime limits

`backend/src/aws/service/portal-input-parity.test.ts` compares independently constructed manual workbooks against generated service workbooks for all 13 generic adapters. UHC and IEHP runner preparation is also checked in `backend/src/aws/worker/submission-parity.test.ts`; Availity project preprocessing and custom rules are covered in `backend/src/aws/service/availity-service.test.ts`.

These are local tests of input preparation and shared runtime behavior, not live portal certification. Medpoint's existing headed-browser/reCAPTCHA restriction remains: input equivalence does not make it usable in headless Fargate. Required portal credentials, account permissions, OTP access, and runtime configuration still have to be available for real runs.

Deploy the API, worker image, and frontend to apply the combined changes. No database migration is required.
