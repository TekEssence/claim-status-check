Health Net eligibility is available only for MedRevenu (`projectId=medrevenue`).

Input: Primary Insurance Name = Health Net, Member ID (or Primary Insurance ID#), and DOB. Project rows for other projects and named payers other than Health Net are excluded. Credentials use Email Address (or Username), Password, and Link (HTTPS login URL); Project and Portal columns isolate rows in shared credential workbooks.

Login uses the supplied username, Continue, password, Login, Text Message, and Send Code elements. The existing frontend `otp_request`/job-input mechanism collects the SMS code. No other portal's OTP implementation is modified. The source document omits the OTP input and verification button, so those two controls currently use accessible-label/autocomplete fallbacks. Live verification and the missing OTP HTML are still needed to confirm those selectors.

The source also supplies result headings rather than their value containers. Extraction reads values following each heading, separates patient Name from Name under PPG Information, and reads Eligibility History by its supplied headers. The full eligibility-for-today message is preserved, including the page's actual date. Every history row is retained in table order, with matching ` | ` separators across Eff Date, End Date, and Plan Type; missing end dates use `-`. No history row is assumed to represent today. Existing MedRevenu output columns remain and Health Net adds Patient Eligibility for Today, Member, Patient Name, Plan Name, and error as needed.

Browser fixtures cover SMS selection and frontend OTP submission, multiple members, PPG versus patient name, history alignment, workbook output, and project/payer isolation. They do not constitute a live Health Net run.
