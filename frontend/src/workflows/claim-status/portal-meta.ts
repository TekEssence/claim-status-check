import type { StaticImageData } from "next/image";
import blueShieldCaliforniaLogo from "../../Assets/customerlogo-blue-shield-california-clr.svg";
import cignaLogo from "../../Assets/cigna-healthcare-logo.svg";
import iehpLogo from "../../Assets/channels4_profile.jpg";
import kaiserLogo from "../../Assets/kaiser-permanente-logo.svg";
import myFamilyLogo from "../../Assets/my-family-medical-group-logo.svg";
import optumLogo from "../../Assets/optum-logo.svg";
import physiciansLogo from "../../Assets/physicians-health-network-logo.svg";
import regalLogo from "../../Assets/channels4_profile (1).jpg";
import availityLogo from "../../Assets/availity-logo.jpg";
import waystarLogo from "../../Assets/waystar-logo-vector.png";
import type { PortalId } from "./shared/model";

export const PORTAL_UI_META: Record<
  PortalId,
  {
    shortCode: string;
    logoClassName: string;
    logoSrc?: string | StaticImageData;
    cardLogoFrameClassName?: string;
    cardLogoImageClassName?: string;
    cardLogoSize?: {
      width: number;
      height: number;
    };
    heroLogoFrameClassName?: string;
    heroLogoImageClassName?: string;
    heroLogoSize?: {
      width: number;
      height: number;
    };
  }
> = {
  iehp: {
    shortCode: "IEHP",
    logoClassName: "bg-white text-blue-700",
    logoSrc: iehpLogo,
    cardLogoFrameClassName: "h-10 w-[5.4rem] rounded-[1rem] px-1.5",
    cardLogoImageClassName: "h-full w-full scale-[2.2] object-contain",
    cardLogoSize: {
      width: 72,
      height: 28,
    },
    heroLogoFrameClassName: "h-14 w-[7.6rem] rounded-[1.15rem] px-2.5",
    heroLogoImageClassName: "h-full w-full scale-[2.2] object-contain",
    heroLogoSize: {
      width: 104,
      height: 40,
    },
  },
  aerial: {
    shortCode: "AC",
    logoClassName: "bg-[linear-gradient(180deg,#e0ecff_0%,#c7ddff_100%)] text-blue-700",
  },
  "all-care": {
    shortCode: "AC",
    logoClassName: "bg-[linear-gradient(180deg,#e0f2fe_0%,#bae6fd_100%)] text-sky-700",
  },
  astrona: {
    shortCode: "AS",
    logoClassName: "bg-[linear-gradient(180deg,#dff7f3_0%,#bdece4_100%)] text-teal-700",
  },
  regal: {
    shortCode: "RP",
    logoClassName: "bg-white text-violet-700",
    logoSrc: regalLogo,
    cardLogoFrameClassName: "h-11 w-11 rounded-[1.1rem] p-0.5",
    cardLogoImageClassName: "h-full w-full scale-[1.08] rounded-[1rem] object-cover",
    cardLogoSize: {
      width: 44,
      height: 44,
    },
    heroLogoFrameClassName: "h-16 w-16 rounded-[1.35rem] p-0.5",
    heroLogoImageClassName: "h-full w-full scale-[1.08] rounded-[1.2rem] object-cover",
    heroLogoSize: {
      width: 64,
      height: 64,
    },
  },
  "blue-shield": {
    shortCode: "BS",
    logoClassName: "bg-white text-blue-700",
    logoSrc: blueShieldCaliforniaLogo,
    cardLogoFrameClassName: "h-10 w-[4.4rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-5 w-full object-contain",
    cardLogoSize: {
      width: 56,
      height: 20,
    },
    heroLogoFrameClassName: "h-14 w-[6.25rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-7 w-full object-contain",
    heroLogoSize: {
      width: 84,
      height: 28,
    },
  },
  availity: {
    shortCode: "AV",
    logoClassName: "bg-white text-sky-700",
    logoSrc: availityLogo,
    cardLogoFrameClassName: "h-10 w-[5.2rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-6 w-full object-contain",
    cardLogoSize: {
      width: 72,
      height: 24,
    },
    heroLogoFrameClassName: "h-14 w-[7rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-8 w-full object-contain",
    heroLogoSize: {
      width: 96,
      height: 32,
    },
  },
  cigna: {
    shortCode: "CG",
    logoClassName: "bg-white text-blue-700",
    logoSrc: cignaLogo,
    cardLogoFrameClassName: "h-10 w-[5.6rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-7 w-full object-contain",
    cardLogoSize: {
      width: 82,
      height: 36,
    },
    heroLogoFrameClassName: "h-14 w-[8rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-10 w-full object-contain",
    heroLogoSize: {
      width: 116,
      height: 52,
    },
  },
  kaiser: {
    shortCode: "KP",
    logoClassName: "bg-white text-cyan-700",
    logoSrc: kaiserLogo,
    cardLogoFrameClassName: "h-10 w-[8.6rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-6 w-full object-contain",
    cardLogoSize: {
      width: 124,
      height: 24,
    },
    heroLogoFrameClassName: "h-14 w-[12rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-8 w-full object-contain",
    heroLogoSize: {
      width: 176,
      height: 32,
    },
  },
  medpoint: {
    shortCode: "MP",
    logoClassName: "bg-[linear-gradient(180deg,#eef2ff_0%,#dbeafe_100%)] text-indigo-700",
  },
  "my-family": {
    shortCode: "MF",
    logoClassName: "bg-[#111827] text-cyan-700",
    logoSrc: myFamilyLogo,
    cardLogoFrameClassName: "h-10 w-[8.8rem] rounded-[1rem] px-1.5",
    cardLogoImageClassName: "h-full w-full object-contain",
    cardLogoSize: {
      width: 132,
      height: 40,
    },
    heroLogoFrameClassName: "h-14 w-[12.5rem] rounded-[1.15rem] px-2",
    heroLogoImageClassName: "h-full w-full object-contain",
    heroLogoSize: {
      width: 184,
      height: 55,
    },
  },
  "optum-pro": {
    shortCode: "OP",
    logoClassName: "bg-white text-orange-600",
    logoSrc: optumLogo,
    cardLogoFrameClassName: "h-10 w-[5.2rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-6 w-full object-contain",
    cardLogoSize: {
      width: 72,
      height: 24,
    },
    heroLogoFrameClassName: "h-14 w-[7rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-8 w-full object-contain",
    heroLogoSize: {
      width: 96,
      height: 32,
    },
  },
  physicians: {
    shortCode: "PHN",
    logoClassName: "bg-white text-red-700",
    logoSrc: physiciansLogo,
    cardLogoFrameClassName: "h-10 w-[9.4rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-7 w-full object-contain",
    cardLogoSize: {
      width: 136,
      height: 37,
    },
    heroLogoFrameClassName: "h-14 w-[13rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-10 w-full object-contain",
    heroLogoSize: {
      width: 190,
      height: 52,
    },
  },
  uhc: {
    shortCode: "UHC",
    logoClassName: "bg-white text-blue-800",
    logoSrc: "/uhc-logo.svg",
    cardLogoFrameClassName: "h-10 w-[6.6rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-7 w-full object-contain",
    cardLogoSize: {
      width: 94,
      height: 28,
    },
    heroLogoFrameClassName: "h-14 w-[8.5rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-9 w-full object-contain",
    heroLogoSize: {
      width: 120,
      height: 36,
    },
  },
  waystar: {
    shortCode: "WS",
    logoClassName: "bg-white text-slate-700",
    logoSrc: waystarLogo,
    cardLogoFrameClassName: "h-10 w-[6.1rem] rounded-[1rem] px-2.5",
    cardLogoImageClassName: "h-full w-full scale-[1.55] object-contain",
    cardLogoSize: {
      width: 92,
      height: 28,
    },
    heroLogoFrameClassName: "h-14 w-[8.2rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-full w-full scale-[1.55] object-contain",
    heroLogoSize: {
      width: 120,
      height: 38,
    },
  },
};

export const PORTAL_WORKSPACE_META: Record<
  PortalId,
  {
    heroDescription: string;
    processingDescription: string;
  }
> = {
  iehp: {
    heroDescription: "Upload your login workbook and claim workbook to begin automated claim status verification with live workbook updates.",
    processingDescription: "Your files are validated before processing and the linked workbook is updated in place as claim checks complete.",
  },
  aerial: {
    heroDescription: "Upload your login workbook and claim details workbook to begin automated claim status verification.",
    processingDescription: "The platform validates workbook structure, secures the upload, and starts payer automation with live status tracking.",
  },
  "all-care": {
    heroDescription: "Upload All Care Group/Payer credentials and claim rows for DOS- and CPT-specific status checks.",
    processingDescription: "All Care routes each row to the matching Group and Responsible Payer login, then reads the matching service line.",
  },
  astrona: {
    heroDescription: "Upload Astrona Group/Payer credentials and member claim rows to begin automated claim-status verification.",
    processingDescription: "Astrona isolates each Group and Payer login, selects the matching IPA, and extracts every available claim and service CPT.",
  },
  regal: {
    heroDescription: "Upload the Regal workbook package to start a guided automation workflow with secure validation and live progress tracking.",
    processingDescription: "If needed, you can override environment credentials and continue the Regal flow with secure OTP-assisted verification.",
  },
  "blue-shield": {
    heroDescription: "Upload your login workbook and input workbook to begin Blue Shield claim status verification grouped by member-ready processing.",
    processingDescription: "Blue Shield requests are validated by group, encrypted during upload, and processed with checkpoint-aware automation.",
  },
  availity: {
    heroDescription: "Upload your Availity login workbook and claim workbook to process Aetna, Anthem-CA, Blue Cross Blue Shield, Wellpoint, Wellcare, Humana, Central Health Medicare Plan, Health Net, Molina, Providence Health Plan, Scan Health, TRIWEST-TRICARE, and TRIWEST-VA CCN claim status checks.",
    processingDescription: "Availity requests stream live status over SSE and automatically download the completed output workbook.",
  },
  cigna: {
    heroDescription: "Upload the Cigna login workbook and claim workbook to search Cigna for Health Care Professionals by patient ID, patient name, DOS, and CPT.",
    processingDescription: "Cigna rows stream live progress and download an output workbook with claim, payment, procedure, and remark-code details.",
  },
  kaiser: {
    heroDescription: "Upload the Kaiser EpicLink login workbook and claim workbook to search claim status by Member ID, DOS, and CPT.",
    processingDescription: "Kaiser rows stream live progress and download an output workbook with claim, payment, service, and denial details.",
  },
  medpoint: {
    heroDescription: "Upload the Medpoint login workbook and claim workbook to start Medpoint claim status verification.",
    processingDescription: "Medpoint requests stream live progress and download claim status output when the run completes.",
  },
  "my-family": {
    heroDescription: "Upload the My family EZ-NET login workbook and claim workbook to search claims by Member ID or patient name and service date.",
    processingDescription: "My family rows stream live progress and download an output workbook with claim, status, payment, and service-line details.",
  },
  "optum-pro": {
    heroDescription: "Upload the One Healthcare ID login workbook and Optum Pro claim workbook, then enter OTP when prompted.",
    processingDescription: "Optum Pro streams progress, supports manual OTP entry, and downloads full or partial output workbooks.",
  },
  physicians: {
    heroDescription: "Upload the PHN QuickCap login workbook and claim workbook to search claims by Member ID and service date.",
    processingDescription: "Physicians rows stream live progress and download an output workbook with claim, payment, service-line, and authorization details.",
  },
  uhc: {
    heroDescription: "Upload your UHC login workbook and claim workbook to process UnitedHealthcare claim status checks for Minimax or MedRevenu.",
    processingDescription: "UHC requests stream live status, prompt for OTP or provider selection when needed, and update the selected workbook in place.",
  },
  waystar: {
    heroDescription: "Upload the Waystar login workbook and claim details workbook to begin claim status verification.",
    processingDescription: "Waystar streams live progress and produces an output workbook with the extracted claim status results.",
  },
};


