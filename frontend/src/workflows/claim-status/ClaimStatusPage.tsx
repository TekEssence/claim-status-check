"use client";

import { motion } from "framer-motion";
import { FormEvent, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  FileSpreadsheet,
  LayoutDashboard,
  LogOut,
  ShieldEllipsis,
  Search,
  SlidersHorizontal,
  Stethoscope,
  Users,
} from "lucide-react";
import dashboardWelcomeImage from "../../Assets/ChatGPT Image Jul 1, 2026, 10_55_01 AM.png";
import { applyUhcRowUpdateToWorksheet, postProcessUhcWorksheet } from "./portals/uhc/workbook";
import {
  cancelScrapeJob as cancelScrapeJobRequest,
  forceStopScrapeJob,
  getActiveScrapeJobErrorId,
  getCurrentScrapeJob,
  getScrapeJobDetails,
  getScrapeJobDownload,
  isAwsWorkflowMode,
  listScrapeJobs,
  startScrapeJob,
  subscribeToScrapeJobEvents,
  submitScrapeJobInput,
  ScrapeJobAuthError,
  type CurrentScrapeJob,
  type ScrapeJobSummary,
} from "../../api/scrape-jobs-api";
import { clearCognitoAccessToken, getCognitoAccessToken, getCognitoUserProfile, isCognitoMode, redirectToCognitoLogin, redirectToCognitoLogout, storeCognitoTokenFromHash } from "../../api/cognito-auth";
import { clearStoredRunContext, loadClaimFileHandle, loadIehpLoginFile, saveClaimFileHandle, saveIehpLoginFile } from "../../lib/run-context-store";
import type { FileSystemFileHandle } from "../../types/file-system-access";
import type { ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../../types/job";
import { IehpInputForm } from "./portals/iehp/IehpInputForm";
import { IehpResultView } from "./portals/iehp/IehpResultView";
import { AerialInputForm, type AerialSubportal } from "./portals/aerial/AerialInputForm";
import { getAerialSubportal } from "./portals/aerial/subportals/registry";
import { AerialResultView } from "./portals/aerial/AerialResultView";
import { RegalInputForm } from "./portals/regal/RegalInputForm";
import { RegalResultView } from "./portals/regal/RegalResultView";
import { BlueShieldInputForm } from "./portals/blue-shield/BlueShieldInputForm";
import { BlueShieldResultView } from "./portals/blue-shield/BlueShieldResultView";
import { AvailityInputForm } from "./portals/availity/AvailityInputForm";
import { AvailityResultView } from "./portals/availity/AvailityResultView";
import { UhcInputForm } from "./portals/uhc/UhcInputForm";
import { UhcResultView, type UhcProviderPrompt } from "./portals/uhc/UhcResultView";
import { AstronaInputForm } from "./portals/astrona/AstronaInputForm";
import { AstronaResultView } from "./portals/astrona/AstronaResultView";
import { AllCareInputForm } from "./portals/all-care/AllCareInputForm";
import { AllCareResultView } from "./portals/all-care/AllCareResultView";
import { CignaInputForm } from "./portals/cigna/CignaInputForm";
import { CignaResultView } from "./portals/cigna/CignaResultView";
import { KaiserInputForm } from "./portals/kaiser/KaiserInputForm";
import { KaiserResultView } from "./portals/kaiser/KaiserResultView";
import { MyFamilyInputForm } from "./portals/my_family/MyFamilyInputForm";
import { MyFamilyResultView } from "./portals/my_family/MyFamilyResultView";
import { OptumProInputForm } from "./portals/optum-pro/OptumProInputForm";
import { OptumProResultView } from "./portals/optum-pro/OptumProResultView";
import { PhysiciansInputForm } from "./portals/physicians/PhysiciansInputForm";
import { PhysiciansResultView } from "./portals/physicians/PhysiciansResultView";
import { WaystarInputForm } from "./portals/waystar/WaystarInputForm";
import { WaystarResultView } from "./portals/waystar/WaystarResultView";
import { claimStatusPortalRegistry } from "./registry";
import { OperationsRunningJobsPanel, OutputsPanel, WorkflowRunsPanel } from "./components/WorkflowPanels";
import { LoginView } from "./components/LoginView";
import { ManageUsersView, ResetPasswordView } from "./components/AccountViews";
import { PortalDirectory } from "./components/PortalDirectory";
import { PortalWorkspaceHeader } from "./components/PortalWorkspaceHeader";
import { ClaimStatusSidebar, ClaimStatusTopNav } from "./components/ClaimStatusNavigation";
import { PortalFormRenderer, PortalResultRenderer } from "./components/PortalViewRegistry";
import { usePortalCatalog } from "./hooks/usePortalCatalog";
import { useWorkflowPrompts } from "./hooks/useWorkflowPrompts";
import { usePortalWorkflow } from "./hooks/usePortalWorkflow";
import { useAvailityController } from "./portals/availity/useAvailityController";
import { useUhcController } from "./portals/uhc/useUhcController";

import {
  PORTAL_ROUTE_MAP, SELECTED_PORTAL_STORAGE_KEY, SKIP_JOB_RESTORE_ONCE_KEY,
  canRestoreCurrentJob, formatRunTimestamp, formatShortJobId, formatUploadedJobFiles,
  formatUserRole, formatWorkflowLabel, hasExcelOutput, hasFullWorkflowAccess,
  isExcelOutputArtifact, isLiveWorkflowStatus, isPortalId, isTerminalWorkflowStatus, persistCachedAuthUser,
  type AuthUser, type DashboardStatsData, type DownloadableArtifact,
  type ManagedUser, type PortalId,
} from "./shared/model";
import { PORTAL_UI_META, PORTAL_WORKSPACE_META } from "./portal-meta";

import {
  base64ToBytes, buildDownloadArtifactKey, downloadBase64File,
  downloadDebugHtmlArtifacts, downloadStoredJobOutputOnce, downloadTextFile,
  downloadZip, getErrorMessage, getEventRowIndex, hasDownloadedArtifact,
  rememberDownloadedArtifact, screenshotsFromArtifacts, textToBytes,
  type DownloadFile,
} from "./shared/artifacts";
import {
  getMissingLocalExcelMessage, loadIehpWorkbookBundle,
  isFileAccessPermissionError, loadUhcWorkbookBundle, selectExcelFileHandle,
  type UhcWorkbookBundle,
} from "./shared/workbook-files";
export function ClaimStatusPage({ forcedPortalId = null }: { forcedPortalId?: PortalId | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    blueShieldOtpRequest, blueShieldOtpValue,
    cignaOtpRequest, cignaOtpValue, optumProOtpRequest, optumProOtpValue,
    regalMfaRequest, regalMfaValue, regalOtpRequest, regalOtpValue,
    setBlueShieldOtpRequest, setBlueShieldOtpValue, setCignaOtpRequest, setCignaOtpValue,
    setOptumProOtpRequest, setOptumProOtpValue, setRegalMfaRequest,
    setRegalMfaValue, setRegalOtpRequest, setRegalOtpValue,
  } = useWorkflowPrompts();
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [activeView, setActiveView] = useState<"portal-selection" | "manage-users" | "reset-password" | "outputs">("portal-selection");
  const [manageTab, setManageTab] = useState<"add" | "employees">("add");
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [manageError, setManageError] = useState("");
  const [manageStatus, setManageStatus] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [editingUserId, setEditingUserId] = useState("");
  const [editingEmail, setEditingEmail] = useState("");
  const [settingsPassword, setSettingsPassword] = useState("");
  const [settingsConfirmPassword, setSettingsConfirmPassword] = useState("");
  const [settingsPasswordError, setSettingsPasswordError] = useState("");
  const [settingsPasswordStatus, setSettingsPasswordStatus] = useState("");
  const [settingsPasswordSubmitting, setSettingsPasswordSubmitting] = useState(false);
  const [iehpLoginFile, setIehpLoginFile] = useState<File | null>(null);
  const [claimFileHandle, setClaimFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [claimFileName, setClaimFileName] = useState<string>("");
  const [aerialCredentialFile, setAerialCredentialFile] = useState<File | null>(null);
  const [aerialInputFile, setAerialInputFile] = useState<File | null>(null);
  const [aerialSubportal, setAerialSubportal] = useState<AerialSubportal | null>(null);
  const [waystarLoginFile, setWaystarLoginFile] = useState<File | null>(null);
  const [waystarInputFile, setWaystarInputFile] = useState<File | null>(null);
  const [astronaCredentialFile, setAstronaCredentialFile] = useState<File | null>(null);
  const [astronaInputFile, setAstronaInputFile] = useState<File | null>(null);
  const [astronaResults, setAstronaResults] = useState<Record<string, unknown>[]>([]);
  const [allCareCredentialFile, setAllCareCredentialFile] = useState<File | null>(null);
  const [allCareInputFile, setAllCareInputFile] = useState<File | null>(null);
  const [cignaCredentialFile, setCignaCredentialFile] = useState<File | null>(null);
  const [cignaInputFile, setCignaInputFile] = useState<File | null>(null);
  const [cignaJobId, setCignaJobId] = useState<string>("");
  const [kaiserCredentialFile, setKaiserCredentialFile] = useState<File | null>(null);
  const [kaiserInputFile, setKaiserInputFile] = useState<File | null>(null);
  const [myFamilyCredentialFile, setMyFamilyCredentialFile] = useState<File | null>(null);
  const [myFamilyInputFile, setMyFamilyInputFile] = useState<File | null>(null);
  const [optumProLoginFile, setOptumProLoginFile] = useState<File | null>(null);
  const [optumProInputFile, setOptumProInputFile] = useState<File | null>(null);
  const [physiciansCredentialFile, setPhysiciansCredentialFile] = useState<File | null>(null);
  const [physiciansInputFile, setPhysiciansInputFile] = useState<File | null>(null);
  const [optumProJobId, setOptumProJobId] = useState<string>("");
  const [optumProStopping, setOptumProStopping] = useState(false);
  const [optumProStaleRunAvailable, setOptumProStaleRunAvailable] = useState(false);
  const [blueShieldCredentialFile, setBlueShieldCredentialFile] = useState<File | null>(null);
  const [blueShieldInputFile, setBlueShieldInputFile] = useState<File | null>(null);
  const [blueShieldResetCheckpoint, setBlueShieldResetCheckpoint] = useState(false);
  const [blueShieldJobId, setBlueShieldJobId] = useState<string>("");
  const [regalLoginFile, setRegalLoginFile] = useState<File | null>(null);
  const [regalClaimFile, setRegalClaimFile] = useState<File | null>(null);
  const [regalJobId, setRegalJobId] = useState<string>("");
  const [latestRegalOutput, setLatestRegalOutput] = useState<DownloadableArtifact | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshots, setErrorScreenshots] = useState<ErrorScreenshot[]>([]);
  const [progress, setProgress] = useState<JobProgressValue | null>(null);
  const [activeJobId, setActiveJobId] = useState<string>("");
  const [workflowRuns, setWorkflowRuns] = useState<ScrapeJobSummary[]>([]);
  const [workflowRunsLoading, setWorkflowRunsLoading] = useState(false);
  const [workflowRunsError, setWorkflowRunsError] = useState("");
  const [operationsRunningJobs, setOperationsRunningJobs] = useState<ScrapeJobSummary[]>([]);
  const [operationsRunningJobsLoading, setOperationsRunningJobsLoading] = useState(false);
  const [operationsRunningJobsError, setOperationsRunningJobsError] = useState("");
  const [forceStoppingWorkflowJobId, setForceStoppingWorkflowJobId] = useState("");
  const [selectedWorkflowRunId, setSelectedWorkflowRunId] = useState("");
  const [downloadingWorkflowJobId, setDownloadingWorkflowJobId] = useState("");
  const [cancellingWorkflowJobId, setCancellingWorkflowJobId] = useState("");
  const [jobRestoreLoading, setJobRestoreLoading] = useState(true);
  const [pendingIehpRestoreJob, setPendingIehpRestoreJob] = useState<CurrentScrapeJob | null>(null);
  const [pendingRegalRestoreJob, setPendingRegalRestoreJob] = useState<CurrentScrapeJob | null>(null);
  const [pendingBlueShieldRestoreJob, setPendingBlueShieldRestoreJob] = useState<CurrentScrapeJob | null>(null);
  const [dashboardStatsData, setDashboardStatsData] = useState<DashboardStatsData>({
    availablePortals: 0,
    completedClaimsToday: 0,
    failedJobsToday: 0,
    portalsRunToday: 0,
    runningJobs: 0,
  });

  const isProtectedRoute = pathname !== "/";
  const {
    availablePortals, effectivePortalId, filteredPortals, filterMenuOpen,
    portalFilter, portalLayout, portalSearch, portalSort, selectedPortal,
    selectedPortalId, setFilterMenuOpen, setPortalFilter, setPortalLayout,
    setPortalSearch, setPortalSort, setSelectedPortalId,
  } = usePortalCatalog(forcedPortalId, pathname);
  const awsWorkflowMode = isAwsWorkflowMode();
  const authUsesCognito = awsWorkflowMode && isCognitoMode();
  const workflowRunTrackingEnabled = Boolean(authUser);
  const canViewOperationsRunningJobs = hasFullWorkflowAccess(authUser);
  const selectedPortalUiMeta = effectivePortalId ? PORTAL_UI_META[effectivePortalId] : null;
  const visibleWorkflowRuns = useMemo(
    () =>
      workflowRuns.filter((job) =>
        isLiveWorkflowStatus(job.status),
      ),
    [workflowRuns],
  );
  const runningWorkflowRunCount = useMemo(
    () => visibleWorkflowRuns.length,
    [visibleWorkflowRuns],
  );
  const outputWorkflowRuns = useMemo(
    () =>
      workflowRuns.filter((job) =>
        hasExcelOutput(job),
      ),
    [workflowRuns],
  );
  const userDisplayName = useMemo(() => {
    const raw = authUser?.email || authUser?.username || "Afrin";
    const candidate = raw.split("@")[0].replace(/[._-]+/g, " ").trim();
    return candidate
      .split(" ")
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
  }, [authUser]);
  const userInitials = useMemo(
    () =>
      userDisplayName
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase(),
    [userDisplayName],
  );
  const canStartAnotherRun = workflowRunTrackingEnabled || !isProcessing;
  const { runStandardPortalJob } = usePortalWorkflow({
    setActiveJobId,
    setIsProcessing,
    setLogs,
    setProgress,
    setErrorScreenshots,
    setStatus,
    refreshRuns: () => void refreshWorkflowRuns({ silent: true }),
  });
  const availity = useAvailityController({
    canStartAnotherRun,
    activeJobId,
    setStatus,
    resetRunState,
    runStandardPortalJob,
  });
  const {
    canSubmit: canSubmitAvaility,
    credentialFile: availityCredentialFile,
    inputFile: availityInputFile,
    projectId: availityProjectId,
    jobId: availityJobId,
    latestOutput: latestAvailityOutput,
    otpRequest: availityOtpRequest,
    otpValue: availityOtpValue,
    setCredentialFile: setAvailityCredentialFile,
    setInputFile: setAvailityInputFile,
    setProjectId: setAvailityProjectId,
    setJobId: setAvailityJobId,
    setLatestOutput: setLatestAvailityOutput,
    setOtpRequest: setAvailityOtpRequest,
    setOtpValue: setAvailityOtpValue,
    submit: submitAvaility,
    submitOtp: submitAvailityOtp,
    downloadLatestOutput: downloadLatestAvailityOutput,
    canDownloadOutput: canDownloadAvailityOutput,
  } = availity;
  const {
    uhcLoginFile, setUhcLoginFile, uhcClaimFileHandle, uhcClaimFileName,
    uhcGroupId, setUhcGroupId, uhcBrowserType, setUhcBrowserType, uhcJobId, setUhcJobId,
    uhcOtpRequest, setUhcOtpRequest, uhcOtpValue, setUhcOtpValue, uhcProviderPrompt, setUhcProviderPrompt,
    canSubmitUhc, selectUhcClaimFile, submitUhcOtp, submitUhcProviderSelection, submitUhc,
  } = useUhcController({
    canStartAnotherRun,
    resetRunState,
    setSelectedPortalId,
    setActiveJobId,
    setIsProcessing,
    setStatus,
    setLogs,
    setProgress,
    setErrorScreenshots,
    refreshRuns: () => void refreshWorkflowRuns({ silent: true }),
  });
  const blockPortalFormForProcessing = isProcessing && !workflowRunTrackingEnabled;
  const canSubmitIehp = useMemo(
    () => Boolean(iehpLoginFile && claimFileHandle && canStartAnotherRun),
    [iehpLoginFile, claimFileHandle, canStartAnotherRun],
  );
  const selectedAerialSubportal = getAerialSubportal(aerialSubportal);
  const canSubmitAerial = useMemo(
    () => Boolean(
      selectedAerialSubportal
      && aerialInputFile
      && (!selectedAerialSubportal.requiresCredentialFile || aerialCredentialFile)
      && canStartAnotherRun,
    ),
    [aerialCredentialFile, aerialInputFile, selectedAerialSubportal, canStartAnotherRun],
  );
  const canSubmitAstrona = useMemo(
    () => Boolean(astronaCredentialFile && astronaInputFile && canStartAnotherRun),
    [astronaCredentialFile, astronaInputFile, canStartAnotherRun],
  );
  const canSubmitAllCare = useMemo(
    () => Boolean(allCareCredentialFile && allCareInputFile && canStartAnotherRun),
    [allCareCredentialFile, allCareInputFile, canStartAnotherRun],
  );
  const canSubmitCigna = useMemo(
    () => Boolean(cignaCredentialFile && cignaInputFile && canStartAnotherRun),
    [cignaCredentialFile, cignaInputFile, canStartAnotherRun],
  );
  const canSubmitKaiser = useMemo(
    () => Boolean(kaiserCredentialFile && kaiserInputFile && canStartAnotherRun),
    [kaiserCredentialFile, kaiserInputFile, canStartAnotherRun],
  );
  const canSubmitMyFamily = useMemo(
    () => Boolean(myFamilyCredentialFile && myFamilyInputFile && canStartAnotherRun),
    [myFamilyCredentialFile, myFamilyInputFile, canStartAnotherRun],
  );
  const canSubmitOptumPro = useMemo(
    () => Boolean(optumProLoginFile && optumProInputFile && canStartAnotherRun),
    [optumProLoginFile, optumProInputFile, canStartAnotherRun],
  );
  const canSubmitPhysicians = useMemo(
    () => Boolean(physiciansCredentialFile && physiciansInputFile && canStartAnotherRun),
    [physiciansCredentialFile, physiciansInputFile, canStartAnotherRun],
  );
  const canSubmitRegal = useMemo(
    () => Boolean(regalClaimFile && canStartAnotherRun),
    [regalClaimFile, canStartAnotherRun],
  );
  const canSubmitBlueShield = useMemo(
    () => Boolean(blueShieldCredentialFile && blueShieldInputFile && canStartAnotherRun),
    [blueShieldCredentialFile, blueShieldInputFile, canStartAnotherRun],
  );
  const canSubmitWaystar = useMemo(
    () => Boolean(waystarLoginFile && waystarInputFile && canStartAnotherRun),
    [waystarInputFile, waystarLoginFile, canStartAnotherRun],
  );
  const canSubmitByPortal: Record<PortalId, boolean> = {
    iehp: canSubmitIehp,
    aerial: canSubmitAerial,
    "all-care": canSubmitAllCare,
    astrona: canSubmitAstrona,
    regal: canSubmitRegal,
    "blue-shield": canSubmitBlueShield,
    availity: canSubmitAvaility,
    cigna: canSubmitCigna,
    kaiser: canSubmitKaiser,
    medpoint: false,
    "my-family": canSubmitMyFamily,
    "optum-pro": canSubmitOptumPro,
    physicians: canSubmitPhysicians,
    uhc: canSubmitUhc,
    waystar: canSubmitWaystar,
  };
  const currentCanSubmit = effectivePortalId ? canSubmitByPortal[effectivePortalId] : false;
  const portalWorkflowMeta = effectivePortalId ? PORTAL_WORKSPACE_META[effectivePortalId] : null;
  const portalFileState = useMemo(() => {
    if (effectivePortalId === "iehp") {
      return {
        claimFileLabel: claimFileName,
        claimReady: Boolean(claimFileName),
        loginFileLabel: iehpLoginFile?.name ?? "",
        loginReady: Boolean(iehpLoginFile),
      };
    }

    if (effectivePortalId === "aerial") {
      return {
        claimFileLabel: aerialInputFile?.name ?? "",
        claimReady: Boolean(aerialInputFile),
        loginFileLabel: aerialCredentialFile?.name ?? "",
        loginReady: Boolean(aerialCredentialFile),
      };
    }

    if (effectivePortalId === "regal") {
      return {
        claimFileLabel: regalClaimFile?.name ?? "",
        claimReady: Boolean(regalClaimFile),
        loginFileLabel: regalLoginFile?.name ?? "",
        loginReady: Boolean(regalLoginFile),
      };
    }

    if (effectivePortalId === "availity") {
      return {
        claimFileLabel: availityInputFile?.name ?? "",
        claimReady: Boolean(availityInputFile),
        loginFileLabel: availityCredentialFile?.name ?? "",
        loginReady: Boolean(availityCredentialFile),
      };
    }

    if (effectivePortalId === "waystar") {
      return {
        claimFileLabel: waystarInputFile?.name ?? "",
        claimReady: Boolean(waystarInputFile),
        loginFileLabel: waystarLoginFile?.name ?? "",
        loginReady: Boolean(waystarLoginFile),
      };
    }

    if (effectivePortalId === "uhc") {
      return {
        claimFileLabel: uhcClaimFileName,
        claimReady: Boolean(uhcClaimFileHandle),
        loginFileLabel: uhcLoginFile?.name ?? "",
        loginReady: Boolean(uhcLoginFile),
      };
    }

    if (effectivePortalId === "astrona") {
      return {
        claimFileLabel: astronaInputFile?.name ?? "",
        claimReady: Boolean(astronaInputFile),
        loginFileLabel: astronaCredentialFile?.name ?? "",
        loginReady: Boolean(astronaCredentialFile),
      };
    }

    if (effectivePortalId === "all-care") {
      return {
        claimFileLabel: allCareInputFile?.name ?? "",
        claimReady: Boolean(allCareInputFile),
        loginFileLabel: allCareCredentialFile?.name ?? "",
        loginReady: Boolean(allCareCredentialFile),
      };
    }

    if (effectivePortalId === "cigna") {
      return {
        claimFileLabel: cignaInputFile?.name ?? "",
        claimReady: Boolean(cignaInputFile),
        loginFileLabel: cignaCredentialFile?.name ?? "",
        loginReady: Boolean(cignaCredentialFile),
      };
    }

    if (effectivePortalId === "kaiser") {
      return {
        claimFileLabel: kaiserInputFile?.name ?? "",
        claimReady: Boolean(kaiserInputFile),
        loginFileLabel: kaiserCredentialFile?.name ?? "",
        loginReady: Boolean(kaiserCredentialFile),
      };
    }

    if (effectivePortalId === "my-family") {
      return {
        claimFileLabel: myFamilyInputFile?.name ?? "",
        claimReady: Boolean(myFamilyInputFile),
        loginFileLabel: myFamilyCredentialFile?.name ?? "",
        loginReady: Boolean(myFamilyCredentialFile),
      };
    }

    if (effectivePortalId === "blue-shield") {
      return {
        claimFileLabel: blueShieldInputFile?.name ?? "",
        claimReady: Boolean(blueShieldInputFile),
        loginFileLabel: blueShieldCredentialFile?.name ?? "",
        loginReady: Boolean(blueShieldCredentialFile),
      };
    }

    if (effectivePortalId === "physicians") {
      return {
        claimFileLabel: physiciansInputFile?.name ?? "",
        claimReady: Boolean(physiciansInputFile),
        loginFileLabel: physiciansCredentialFile?.name ?? "",
        loginReady: Boolean(physiciansCredentialFile),
      };
    }

    if (effectivePortalId === "optum-pro") {
      return {
        claimFileLabel: optumProInputFile?.name ?? "",
        claimReady: Boolean(optumProInputFile),
        loginFileLabel: optumProLoginFile?.name ?? "",
        loginReady: Boolean(optumProLoginFile),
      };
    }

    return {
      claimFileLabel: "",
      claimReady: false,
      loginFileLabel: "",
      loginReady: false,
    };
  }, [
    aerialCredentialFile,
    aerialInputFile,
    allCareCredentialFile,
    allCareInputFile,
    availityCredentialFile,
    availityInputFile,
    astronaCredentialFile,
    astronaInputFile,
    blueShieldCredentialFile,
    blueShieldInputFile,
    cignaCredentialFile,
    cignaInputFile,
    claimFileName,
    effectivePortalId,
    iehpLoginFile,
    kaiserCredentialFile,
    kaiserInputFile,
    myFamilyCredentialFile,
    myFamilyInputFile,
    optumProInputFile,
    optumProLoginFile,
    physiciansCredentialFile,
    physiciansInputFile,
    regalClaimFile,
    regalLoginFile,
    uhcClaimFileHandle,
    uhcClaimFileName,
    uhcLoginFile,
    waystarInputFile,
    waystarLoginFile,
  ]);
  const portalWorkflowStepIndex = useMemo(() => {
    const normalizedStatus = status.toLowerCase();
    const isCompleted =
      !isProcessing &&
      Boolean(status.trim()) &&
      /(complete|completed|success|finished|done|saved|updated)/i.test(normalizedStatus);

    if (isCompleted) return 4;
    if (isProcessing) return 3;
    if (currentCanSubmit) return 2;
    if (portalFileState.claimReady) return 1;
    return 0;
  }, [currentCanSubmit, isProcessing, portalFileState.claimReady, status]);
  const hasCompletedRun = useMemo(
    () => !isProcessing && Boolean(status.trim()) && /(complete|completed|success|finished|done|saved|updated)/i.test(status.toLowerCase()),
    [isProcessing, status],
  );
  const portalWorkflowSteps = [
    "Upload Login File",
    "Upload Claim File",
    "Validate Files",
    "Processing",
    "Completed",
  ];

  function navigateToPortalRoute(portalId: PortalId, replace = false) {
    const targetRoute = PORTAL_ROUTE_MAP[portalId];
    if (pathname !== targetRoute) {
      if (replace) {
        router.replace(targetRoute);
      } else {
        router.push(targetRoute);
      }
    }
  }

  function updateAuthUser(nextUser: AuthUser | null) {
    setAuthUser(nextUser);
    persistCachedAuthUser(nextUser);
  }

  function handleAwsAuthFailure(error: unknown): boolean {
    if (!authUsesCognito || !(error instanceof ScrapeJobAuthError)) return false;
    clearCognitoAccessToken();
    updateAuthUser(null);
    setWorkflowRuns([]);
    setWorkflowRunsError("");
    setOperationsRunningJobs([]);
    setOperationsRunningJobsError("");
    setIsProcessing(false);
    redirectToCognitoLogin();
    return true;
  }

  function markSkipJobRestoreOnce() {
    try {
      window.sessionStorage.setItem(SKIP_JOB_RESTORE_ONCE_KEY, "true");
    } catch {
      // Ignore storage failures.
    }
  }

  useEffect(() => {
    if (authUsesCognito) {
      const hasToken = storeCognitoTokenFromHash() || Boolean(getCognitoAccessToken());
      if (hasToken) {
        const profile = getCognitoUserProfile();
        updateAuthUser({
          userId: profile?.userId || "cognito",
          username: profile?.username || "Cognito user",
          email: profile?.email || "Signed in with Cognito",
          role: profile?.role || "USER",
          mustResetPassword: false,
        });
      } else {
        updateAuthUser(null);
      }
      setAuthLoading(false);
      return;
    }

    let mounted = true;

    fetch("/api/auth/me")
      .then(async (response) => {
        if (!mounted) return;
        if (!response.ok) {
          updateAuthUser(null);
          return;
        }
        const data = await response.json();
        updateAuthUser(data.user ?? null);
      })
      .catch(() => {
        if (mounted) updateAuthUser(null);
      })
      .finally(() => {
        if (mounted) setAuthLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [authUsesCognito]);

  useEffect(() => {
    if (!authLoading && !authUser && isProtectedRoute) {
      router.replace("/");
    }
  }, [authLoading, authUser, isProtectedRoute, router]);

  useEffect(() => {
    if (!authUser) {
      setJobRestoreLoading(false);
      return;
    }

    try {
      if (window.sessionStorage.getItem(SKIP_JOB_RESTORE_ONCE_KEY) === "true") {
        window.sessionStorage.removeItem(SKIP_JOB_RESTORE_ONCE_KEY);
        setJobRestoreLoading(false);
        return;
      }
    } catch {
      // Ignore storage failures.
    }

    let cancelled = false;

    const restoreCurrentRun = async () => {
      try {
        const currentJob = await getCurrentScrapeJob();
        if (cancelled || !currentJob) return;
        if (!canRestoreCurrentJob(currentJob)) return;
        if (pathname === "/claim-status") return;
        if (forcedPortalId && currentJob.portalId !== forcedPortalId) return;

        setErrorScreenshots(screenshotsFromArtifacts(currentJob));
        if (currentJob.portalId === "iehp") {
          downloadDebugHtmlArtifacts(currentJob);
        }
        setProgress(
          currentJob.totalRows > 0
            ? { completed: currentJob.currentCompleted, total: currentJob.totalRows }
            : null,
        );
        setActiveView("portal-selection");

        if (currentJob.portalId === "blue-shield") {
          setActiveJobId(currentJob.jobId);
          setPendingBlueShieldRestoreJob(currentJob);
          setSelectedPortalId("blue-shield");
          setIsProcessing(false);
          setStatus("A previous Blue Shield run is still active. Use the active-runs table to view or cancel that specific run.");
          return;
        }

        setStatus(`Reconnected to ${currentJob.portalId.toUpperCase()} run in progress...`);
        setIsProcessing(true);
        setActiveJobId(currentJob.jobId);
        setSelectedPortalId(currentJob.portalId as PortalId);
        navigateToPortalRoute(currentJob.portalId as PortalId, true);
        setActiveView("portal-selection");

        if (currentJob.portalId === "iehp") {
          const [storedClaimHandle, storedLoginFile] = await Promise.all([loadClaimFileHandle(), loadIehpLoginFile()]);
          if (cancelled) return;
          let canAutoResumeIehp = true;

          if (storedClaimHandle) {
            setClaimFileHandle(storedClaimHandle);
            setClaimFileName(currentJob.claimFileName || "");
            const currentPermission = await storedClaimHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const);
            if (currentPermission !== "granted") {
              canAutoResumeIehp = false;
            }
          }
          if (storedLoginFile) {
            setIehpLoginFile(storedLoginFile);
          }

          if (storedClaimHandle && storedLoginFile && canAutoResumeIehp) {
            await resumeExistingIehpRun(currentJob, storedClaimHandle, storedLoginFile);
          } else {
            setPendingIehpRestoreJob(currentJob);
            if (!storedClaimHandle) {
              setStatus(`Could not restore the active run: ${getMissingLocalExcelMessage(currentJob.claimFileName)}`);
            } else if (!canAutoResumeIehp) {
              const normalizedResumeMessage = `Previous IEHP run restored. Click Allow And Continue to continue from row ${currentJob.currentCompleted + 1}.`;
              setStatus(normalizedResumeMessage);
              if (typeof window !== "undefined") {
                window.alert(normalizedResumeMessage);
              }
            } else {
              setStatus("A run is active, but the local IEHP login file context could not be restored automatically. Please upload the login file again if needed.");
            }
            setIsProcessing(false);
          }
        } else if (currentJob.portalId === "aerial") {
          await reconnectAerialRun(currentJob);
        } else if (currentJob.portalId === "availity") {
          await reconnectDownloadOnlyRun(currentJob, "availity", "Availity");
        } else if (currentJob.portalId === "astrona") {
          await reconnectDownloadOnlyRun(currentJob, "astrona", "Astrona");
        } else if (currentJob.portalId === "cigna") {
          await reconnectDownloadOnlyRun(currentJob, "cigna", "Cigna");
        } else if (currentJob.portalId === "kaiser") {
          await reconnectDownloadOnlyRun(currentJob, "kaiser", "Kaiser");
        } else if (currentJob.portalId === "my-family") {
          await reconnectDownloadOnlyRun(currentJob, "my-family", "My family");
        } else if (currentJob.portalId === "physicians") {
          await reconnectDownloadOnlyRun(currentJob, "physicians", "Physicians");
        } else if (currentJob.portalId === "regal") {
          await reconnectRegalRun(currentJob);
        } else if (currentJob.portalId === "optum-pro") {
          await reconnectOptumProRun(currentJob);
        }
      } catch (error) {
        if (!cancelled) {
          if (isFileAccessPermissionError(error) || getErrorMessage(error).includes("Browser file permission is not currently granted")) {
            const currentJob = await getCurrentScrapeJob().catch(() => null);
            if (currentJob?.portalId === "iehp") {
              setPendingIehpRestoreJob(currentJob);
            }
          }
          setStatus(`Could not restore the active run: ${getErrorMessage(error)}`);
          setIsProcessing(false);
        }
      } finally {
        if (!cancelled) {
          setJobRestoreLoading(false);
        }
      }
    };

    void restoreCurrentRun();

    return () => {
      cancelled = true;
    };
  }, [authUser, forcedPortalId, pathname]);

  useEffect(() => {
    if (!authUser) {
      return;
    }

    if (authUser.mustResetPassword) {
      setSettingsOpen(false);
      setSelectedPortalId(null);
      setActiveView("reset-password");
      return;
    }

    if (activeView === "reset-password") {
      setActiveView("portal-selection");
    }
  }, [authUser, activeView]);

  useEffect(() => {
    if (!authUser || authUser.mustResetPassword || pathname !== "/claim-status") return;
    const requestedView = new URLSearchParams(window.location.search).get("view");
    if (requestedView === "reset-password") {
      void openResetPassword();
    } else if (requestedView === "manage-users" && hasFullWorkflowAccess(authUser)) {
      void openManageUsers();
    }
  }, [authUser, pathname]);

  useEffect(() => {
    if (forcedPortalId) {
      setSelectedPortalId(forcedPortalId);
      return;
    }

    if (pathname === "/claim-status" || !authUser || authUser.mustResetPassword || selectedPortalId) {
      return;
    }

    try {
      const storedPortalId = window.localStorage.getItem(SELECTED_PORTAL_STORAGE_KEY);
      if (storedPortalId && isPortalId(storedPortalId)) {
        setSelectedPortalId(storedPortalId);
        navigateToPortalRoute(storedPortalId, true);
      }
    } catch {
      // Ignore storage failures.
    }
  }, [authUser, selectedPortalId, forcedPortalId, pathname]);

  useEffect(() => {
    if (!isProcessing || !activeJobId) return;

    let cancelled = false;
    const synchronizeActiveJobProgress = async () => {
      const details = await getScrapeJobDetails(activeJobId).catch(() => null);
      if (cancelled || !details) return;
      if (details.totalRows > 0) {
        setProgress((previous) => {
          const previousCompleted = previous?.completed ?? 0;
          const completed = Math.max(previousCompleted, details.currentCompleted);
          return {
            completed,
            total: details.totalRows,
            currentRow: details.currentCompleted > previousCompleted ? undefined : previous?.currentRow,
          };
        });
      }
      if (isTerminalWorkflowStatus(details.status)) {
        try {
          const filename = await downloadStoredJobOutputOnce(details.jobId);
          setStatus(filename
            ? `${details.portalId.toUpperCase()} run finished. Download started for ${filename}.`
            : `${details.portalId.toUpperCase()} run ${formatShortJobId(details.jobId)} is ${details.status.replace(/_/g, " ")}.`);
        } catch (error) {
          setStatus(`${details.portalId.toUpperCase()} run finished, but automatic output download failed: ${getErrorMessage(error)}`);
        }
        setIsProcessing(false);
      }
    };

    void synchronizeActiveJobProgress();
    const timer = window.setInterval(() => void synchronizeActiveJobProgress(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJobId, isProcessing]);
  useEffect(() => {
    if (!authUser) {
      setDashboardStatsData({
        availablePortals: availablePortals.length,
        completedClaimsToday: 0,
        failedJobsToday: 0,
        portalsRunToday: 0,
        runningJobs: 0,
      });
      return;
    }

    let cancelled = false;

    fetch("/api/dashboard/stats")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load dashboard stats: ${response.status}`);
        }
        const data = (await response.json()) as { stats?: DashboardStatsData };
        if (!cancelled && data.stats) {
          setDashboardStatsData(data.stats);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDashboardStatsData((current) => ({
            ...current,
            availablePortals: availablePortals.length,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authUser, availablePortals.length]);

  async function refreshWorkflowRuns(options?: { silent?: boolean }) {
    if (!workflowRunTrackingEnabled) {
      setWorkflowRuns([]);
      return;
    }

    if (!options?.silent) {
      setWorkflowRunsLoading(true);
      setWorkflowRunsError("");
    }

    try {
      const jobs = await listScrapeJobs(50);
      setWorkflowRuns(jobs);
      setWorkflowRunsError("");
      setDashboardStatsData((current) => ({
        ...current,
        runningJobs: jobs.filter((job) => isLiveWorkflowStatus(job.status)).length,
      }));
    } catch (error) {
      if (handleAwsAuthFailure(error)) return;
      setWorkflowRunsError(getErrorMessage(error));
    } finally {
      if (!options?.silent) {
        setWorkflowRunsLoading(false);
      }
    }
  }

  async function refreshOperationsRunningJobs(options?: { silent?: boolean }) {
    if (!canViewOperationsRunningJobs) {
      setOperationsRunningJobs([]);
      setOperationsRunningJobsError("");
      return;
    }

    if (!options?.silent) {
      setOperationsRunningJobsLoading(true);
      setOperationsRunningJobsError("");
    }

    try {
      const jobs = await listScrapeJobs(50, { scope: "all-running" });
      setOperationsRunningJobs(jobs.filter((job) => isLiveWorkflowStatus(job.status)));
      setOperationsRunningJobsError("");
    } catch (error) {
      if (handleAwsAuthFailure(error)) return;
      setOperationsRunningJobsError(getErrorMessage(error));
    } finally {
      if (!options?.silent) {
        setOperationsRunningJobsLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!workflowRunTrackingEnabled) return;
    let cancelled = false;

    const load = async (silent: boolean) => {
      if (cancelled) return;
      await refreshWorkflowRuns({ silent });
    };

    void load(false);
    const interval = window.setInterval(() => {
      void load(true);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workflowRunTrackingEnabled, authUser?.userId]);

  useEffect(() => {
    if (!canViewOperationsRunningJobs) {
      setOperationsRunningJobs([]);
      return;
    }
    let cancelled = false;

    const load = async (silent: boolean) => {
      if (cancelled) return;
      await refreshOperationsRunningJobs({ silent });
    };

    void load(false);
    const interval = window.setInterval(() => {
      void load(true);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [canViewOperationsRunningJobs, authUser?.userId]);

  useEffect(() => {
    if (!selectedWorkflowRunId) return;
    const selectedRun = [...workflowRuns, ...operationsRunningJobs].find((job) => job.jobId === selectedWorkflowRunId);
    if (!selectedRun || !isLiveWorkflowStatus(selectedRun.status)) return;

    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await loadWorkflowRunDetails(selectedRun);
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedWorkflowRunId, workflowRuns, operationsRunningJobs]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (forcedPortalId) return;
    try {
      if (selectedPortalId) {
        window.localStorage.setItem(SELECTED_PORTAL_STORAGE_KEY, selectedPortalId);
      } else {
        window.localStorage.removeItem(SELECTED_PORTAL_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures.
    }
  }, [selectedPortalId, forcedPortalId]);

  function resetRunState(message: string) {
    setIsProcessing(true);
    setStatus(message);
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setAstronaResults([]);
    setActiveJobId("");
    setAvailityJobId("");
    setAvailityOtpRequest(null);
    setAvailityOtpValue("");
    setUhcJobId("");
    setUhcOtpRequest(null);
    setUhcOtpValue("");
    setUhcProviderPrompt(null);
    setRegalJobId("");
    setRegalMfaRequest(null);
    setRegalMfaValue("");
    setRegalOtpRequest(null);
    setRegalOtpValue("");
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
    setCignaJobId("");
    setCignaOtpRequest(null);
    setCignaOtpValue("");
    setOptumProJobId("");
    setOptumProOtpRequest(null);
    setOptumProOtpValue("");
    setOptumProStopping(false);
    setOptumProStaleRunAvailable(false);
    setLatestRegalOutput(null);
    setLatestAvailityOutput(null);
  }

  function resetPortalSelection() {
    setActiveView("portal-selection");
    setSettingsOpen(false);
    if (forcedPortalId) {
      try {
        window.localStorage.removeItem(SELECTED_PORTAL_STORAGE_KEY);
      } catch {
        // Ignore storage failures.
      }
      markSkipJobRestoreOnce();
      window.location.replace("/claim-status");
      return;
    }
    setSelectedPortalId(null);
    markSkipJobRestoreOnce();
    try {
      window.localStorage.removeItem(SELECTED_PORTAL_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setAstronaResults([]);
    setIsProcessing(false);
    setActiveJobId("");
    setPendingIehpRestoreJob(null);
    setPendingRegalRestoreJob(null);
    setPendingBlueShieldRestoreJob(null);
    setRegalJobId("");
    setUhcJobId("");
    setUhcOtpRequest(null);
    setUhcOtpValue("");
    setUhcProviderPrompt(null);
    setRegalMfaRequest(null);
    setRegalMfaValue("");
    setRegalOtpRequest(null);
    setRegalOtpValue("");
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
    setCignaJobId("");
    setCignaOtpRequest(null);
    setCignaOtpValue("");
    setCignaCredentialFile(null);
    setCignaInputFile(null);
    setKaiserCredentialFile(null);
    setKaiserInputFile(null);
    setMyFamilyCredentialFile(null);
    setMyFamilyInputFile(null);
    setPhysiciansCredentialFile(null);
    setPhysiciansInputFile(null);
    setOptumProJobId("");
    setOptumProOtpRequest(null);
    setOptumProOtpValue("");
    setOptumProStopping(false);
    setOptumProStaleRunAvailable(false);
  }

  async function loadManagedUsers() {
    setManageError("");
    const response = await fetch("/api/admin/users");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Unable to load users.");
    }
    setManagedUsers(data.users ?? []);
  }

  async function openManageUsers() {
    setActiveView("manage-users");
    setManageStatus("");
    try {
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function openResetPassword() {
    setActiveView("reset-password");
    setSettingsPassword("");
    setSettingsConfirmPassword("");
    setSettingsPasswordError("");
    setSettingsPasswordStatus("");
  }

  async function onAuthSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthSubmitting(true);
    setAuthError("");
    setAuthStatus("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authUsername, password: authPassword }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Login failed.");
      }

      const nextUser = data.user ?? null;
      updateAuthUser(nextUser);
      setAuthUsername("");
      setAuthPassword("");
      setAuthConfirmPassword("");
      if (nextUser?.mustResetPassword) {
        setSelectedPortalId(null);
        setSettingsOpen(false);
        setForgotPasswordMode(false);
        setActiveView("reset-password");
        setAuthStatus("Please update your password before continuing.");
      } else {
        resetPortalSelection();
      }
    } catch (error) {
      setAuthError(getErrorMessage(error));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function onForgotPasswordSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthSubmitting(true);
    setAuthError("");
    setAuthStatus("");

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: authUsername,
          password: authPassword,
          confirmPassword: authConfirmPassword,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Reset password failed.");
      }

      setAuthStatus("Password updated successfully. Please login with the new password.");
      setForgotPasswordMode(false);
      setAuthPassword("");
      setAuthConfirmPassword("");
    } catch (error) {
      setAuthError(getErrorMessage(error));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function logout() {
    if (isCognitoMode()) {
      await clearStoredRunContext().catch(() => {});
      updateAuthUser(null);
      redirectToCognitoLogout();
      return;
    }

    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    await clearStoredRunContext().catch(() => {});
    updateAuthUser(null);
    setAuthUsername("");
    setAuthPassword("");
    setAuthConfirmPassword("");
    setAuthError("");
    setAuthStatus("");
    setForgotPasswordMode(false);
    setActiveView("portal-selection");
    setManagedUsers([]);
    setManageError("");
    setManageStatus("");
    setNewUserEmail("");
    setTemporaryPassword("");
    setEditingUserId("");
    setEditingEmail("");
    setSettingsPassword("");
    setSettingsConfirmPassword("");
    setSettingsPasswordError("");
    setSettingsPasswordStatus("");
    setSettingsPasswordSubmitting(false);
    setSelectedPortalId(null);
    setIehpLoginFile(null);
    setClaimFileHandle(null);
    setClaimFileName("");
    setAerialCredentialFile(null);
    setAerialInputFile(null);
    setAerialSubportal(null);
    setAstronaCredentialFile(null);
    setAstronaInputFile(null);
    setBlueShieldCredentialFile(null);
    setBlueShieldInputFile(null);
    setBlueShieldResetCheckpoint(false);
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
    setCignaCredentialFile(null);
    setCignaInputFile(null);
    setCignaJobId("");
    setCignaOtpRequest(null);
    setCignaOtpValue("");
    setKaiserCredentialFile(null);
    setKaiserInputFile(null);
    setMyFamilyCredentialFile(null);
    setMyFamilyInputFile(null);
    setPhysiciansCredentialFile(null);
    setPhysiciansInputFile(null);
    setOptumProLoginFile(null);
    setOptumProInputFile(null);
    setOptumProJobId("");
    setOptumProOtpRequest(null);
    setOptumProOtpValue("");
    setOptumProStopping(false);
    setOptumProStaleRunAvailable(false);
    setIsProcessing(false);
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setAstronaResults([]);
    setActiveJobId("");
    setWorkflowRuns([]);
    setWorkflowRunsError("");
    setSelectedWorkflowRunId("");
    setPendingIehpRestoreJob(null);
    setPendingBlueShieldRestoreJob(null);
  }

  async function loadWorkflowRunDetails(job: ScrapeJobSummary) {
    try {
      const details = await getScrapeJobDetails(job.jobId);
      setLogs(details.logs);
      setProgress(details.totalRows > 0 ? { completed: details.currentCompleted, total: details.totalRows } : null);
      setStatus(
        `${details.portalId.toUpperCase()} run ${formatShortJobId(details.jobId)} is ${details.status.replace(/_/g, " ")}.`,
      );
    } catch (error) {
      setStatus(`Failed to load run ${formatShortJobId(job.jobId)}: ${getErrorMessage(error)}`);
    }
  }

  async function selectWorkflowRun(job: ScrapeJobSummary) {
    setSelectedWorkflowRunId(job.jobId);
    setSelectedPortalId(isPortalId(job.portalId) ? job.portalId : null);
    if (isPortalId(job.portalId)) {
      navigateToPortalRoute(job.portalId);
    }
    setActiveJobId(job.jobId);
    setProgress(job.totalRows > 0 ? { completed: job.currentCompleted, total: job.totalRows } : null);
    setStatus(
      `${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)} is ${job.status.replace(/_/g, " ")}.`,
    );
    await loadWorkflowRunDetails(job);
  }

  async function cancelWorkflowRun(job: ScrapeJobSummary) {
    if (isTerminalWorkflowStatus(job.status) || cancellingWorkflowJobId) return;

    setCancellingWorkflowJobId(job.jobId);
    setStatus(`Cancelling ${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)}...`);
    try {
      await cancelScrapeJobRequest(job.jobId);
      await refreshWorkflowRuns({ silent: true });
      await refreshOperationsRunningJobs({ silent: true });
      if (activeJobId === job.jobId) {
        setActiveJobId("");
        setIsProcessing(false);
      }
      setStatus(`Cancel requested for ${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)}.`);
    } catch (error) {
      setStatus(`Failed to cancel run ${formatShortJobId(job.jobId)}: ${getErrorMessage(error)}`);
    } finally {
      setCancellingWorkflowJobId("");
    }
  }

  async function forceStopWorkflowRun(job: ScrapeJobSummary) {
    if (!canViewOperationsRunningJobs || isTerminalWorkflowStatus(job.status) || forceStoppingWorkflowJobId) return;

    setForceStoppingWorkflowJobId(job.jobId);
    setStatus(`Force-stopping ${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)}...`);
    try {
      await forceStopScrapeJob(job.jobId);
      await refreshWorkflowRuns({ silent: true });
      await refreshOperationsRunningJobs({ silent: true });
      if (activeJobId === job.jobId) {
        setActiveJobId("");
        setIsProcessing(false);
        setStatus("Processing force-stopped.");
      }
    } catch (error) {
      setStatus(`Failed to force-stop ${job.portalId.toUpperCase()} run: ${getErrorMessage(error)}`);
    } finally {
      setForceStoppingWorkflowJobId("");
    }
  }

  async function downloadWorkflowRun(job: ScrapeJobSummary) {
    if (downloadingWorkflowJobId) return;

    setDownloadingWorkflowJobId(job.jobId);
    setStatus(`Preparing download for ${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)}...`);
    try {
      const { filename, downloadUrl } = await getScrapeJobDownload(job.jobId);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.rel = "noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setStatus(`Download started for ${filename}.`);
    } catch (error) {
      setStatus(`Failed to download run ${formatShortJobId(job.jobId)}: ${getErrorMessage(error)}`);
    } finally {
      setDownloadingWorkflowJobId("");
    }
  }

  function resetBlueShieldWorkflow() {
    setBlueShieldCredentialFile(null);
    setBlueShieldInputFile(null);
    setBlueShieldResetCheckpoint(false);
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setAstronaResults([]);
    setActiveJobId("");
    setPendingBlueShieldRestoreJob(null);
    setIsProcessing(false);
  }

  async function resetPasswordFromSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSettingsPasswordSubmitting(true);
    setSettingsPasswordError("");
    setSettingsPasswordStatus("");

    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: settingsPassword,
          confirmPassword: settingsConfirmPassword,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Password reset failed.");
      }

      const nextUser = data.user ?? authUser;
      updateAuthUser(nextUser);
      setSettingsPassword("");
      setSettingsConfirmPassword("");
      setSettingsPasswordStatus("Password updated successfully.");
      if (nextUser && !nextUser.mustResetPassword) {
        setActiveView("portal-selection");
      }
    } catch (error) {
      setSettingsPasswordError(getErrorMessage(error));
    } finally {
      setSettingsPasswordSubmitting(false);
    }
  }

  async function addManagedUser(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setManageError("");
    setManageStatus("");

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newUserEmail,
          temporaryPassword,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to add user.");
      }

      setManageStatus(`User added. Temporary password: ${data.temporaryPassword}`);
      setNewUserEmail("");
      setTemporaryPassword("");
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function updateUserEmail(userId: string) {
    setManageError("");
    setManageStatus("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: editingEmail }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to update email.");
      }
      setEditingUserId("");
      setEditingEmail("");
      setManageStatus("Employee email updated.");
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function deactivateUser(userId: string) {
    if (!window.confirm("Deactivate this user? They will no longer be able to login.")) return;

    setManageError("");
    setManageStatus("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to deactivate user.");
      }
      setManageStatus("Employee deactivated.");
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function selectClaimFile() {
    try {
      const fileHandle = await selectExcelFileHandle();
      if (!fileHandle) return null;

      setClaimFileHandle(fileHandle);
      await saveClaimFileHandle(fileHandle).catch(() => {});
      const file = await fileHandle.getFile();
      setClaimFileName(file.name);

      if (pendingIehpRestoreJob) {
        const loginFileToUse = iehpLoginFile ?? (await loadIehpLoginFile().catch(() => null));
        if (!loginFileToUse) {
          setStatus("The active IEHP run is waiting, but the login file could not be restored. Please upload the login file again.");
          return fileHandle;
        }

        setIehpLoginFile(loginFileToUse);
        setPendingIehpRestoreJob(null);
        void resumeExistingIehpRun(pendingIehpRestoreJob, fileHandle, loginFileToUse).catch((error) => {
          setPendingIehpRestoreJob(pendingIehpRestoreJob);
          setStatus(`Could not restore the active run: ${getErrorMessage(error)}`);
          setIsProcessing(false);
        });
      }

      return fileHandle;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("Failed to select file:", error);
        setStatus(`Failed to select file: ${getErrorMessage(error)}`);
      }
      return null;
    }
  }

  function handleLoginFileChange(file: File | null) {
    setIehpLoginFile(file);
    if (file) {
      void saveIehpLoginFile(file).catch(() => {});
    }
  }

  async function runIehpSession(options: {
    claimFileHandle: FileSystemFileHandle;
    loginFile: File;
    existingJobId?: string;
    initialStartIndex?: number;
    attachToRunningJob?: boolean;
    initialLogs?: string[];
    initialProgress?: JobProgressValue | null;
    allowPermissionPrompt?: boolean;
  }) {
    const workbookBundle = await loadIehpWorkbookBundle(options.claimFileHandle, {
      requestPermission: options.allowPermissionPrompt ?? true,
      fileNameForErrors: options.claimFileHandle ? claimFileName : "",
    });
    const { claimRows, totalRows } = workbookBundle;

    setClaimFileHandle(options.claimFileHandle);
    const liveClaimFile = await options.claimFileHandle.getFile();
    setClaimFileName(liveClaimFile.name);
    setIehpLoginFile(options.loginFile);
    await saveClaimFileHandle(options.claimFileHandle).catch(() => {});
    await saveIehpLoginFile(options.loginFile).catch(() => {});

    setIsProcessing(true);
    setActiveJobId(options.existingJobId ?? "");
    setLogs(options.initialLogs ?? []);
    setProgress(options.initialProgress ?? null);
    setErrorScreenshots([]);
    setStatus(
      options.attachToRunningJob
        ? "Reconnecting to current IEHP run..."
        : options.initialStartIndex && options.initialStartIndex > 0
          ? `Auto-resuming from row ${options.initialStartIndex + 1}...`
          : `Starting IEHP process for ${totalRows} rows...`,
    );

    const processChunk = async (
      startIndex: number,
      logicalJobId: string,
      mode: "attach" | "start",
    ): Promise<void> => {
      let currentCompleted = startIndex;
      let chunkHasError = false;
      let subscribedJobId = logicalJobId;
      const streamAbortController = new AbortController();

      const handleJobEvent = async (eventData: ScrapeJobEvent) => {
        if (eventData.type === "log" && eventData.message) {
          setLogs((prev) => [...prev, eventData.message ?? ""]);
        } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
          currentCompleted = eventData.completed;
          setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
        } else if (eventData.type === "row_update") {
          // IEHP output is now generated by the worker and stored as a separate S3 artifact.
        } else if (eventData.type === "error_screenshot" && eventData.image) {
          setErrorScreenshots((prev) => [...prev, { index: getEventRowIndex(eventData), image: eventData.image ?? "" }]);
        } else if (eventData.type === "debug_html" && eventData.html) {
          const artifactKey = buildDownloadArtifactKey(eventData);
          if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
            const rowIndex = getEventRowIndex(eventData);
            downloadTextFile(eventData.filename || `debug_dom_line_${rowIndex >= 0 ? rowIndex + 1 : "unknown"}.html`, eventData.html, "text/html");
            rememberDownloadedArtifact(subscribedJobId, artifactKey);
          }
        } else if (eventData.type === "pdf_download" && eventData.filename && eventData.base64) {
          const artifactKey = buildDownloadArtifactKey(eventData);
          if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
            downloadBase64File(eventData.filename, eventData.base64, "application/pdf");
            rememberDownloadedArtifact(subscribedJobId, artifactKey);
          }
        } else if (eventData.type === "error" && eventData.message) {
          setStatus(`Error: ${eventData.message}`);
          chunkHasError = true;
        } else if (eventData.type === "cancelled") {
          chunkHasError = true;
          setStatus(eventData.message || "Processing cancelled.");
          setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
        }
      };

      try {
        if (mode === "start") {
          const formData = new FormData();
          formData.append("portalId", "iehp");
          formData.append("loginExcel", options.loginFile);
          formData.append("loginFileName", options.loginFile.name);
          formData.append("claimExcel", liveClaimFile);
          formData.append("claimFileName", liveClaimFile.name);
          formData.append("claimRows", JSON.stringify(claimRows));
          formData.append("startIndex", startIndex.toString());
          if (logicalJobId) {
            formData.append("existingJobId", logicalJobId);
          }
          subscribedJobId = await startScrapeJob(formData);
          setActiveJobId(subscribedJobId);
          setIehpLoginFile(null);
          setClaimFileHandle(null);
          setClaimFileName("");
          setIsProcessing(false);
          void refreshWorkflowRuns({ silent: true });
        }

        await subscribeToScrapeJobEvents({
          jobId: subscribedJobId,
          signal: streamAbortController.signal,
          onEvent: handleJobEvent,
          onStreamError(error) {
            console.error("Stream error:", error);
            chunkHasError = true;
          },
        });
      } catch (error) {
        console.error("fetchEventSource failed", error);
        chunkHasError = true;
      }

      const effectiveJobId = subscribedJobId || logicalJobId || options.existingJobId || "";

      if (chunkHasError) {
        setIsProcessing(false);
      } else if (currentCompleted < totalRows) {
        setStatus(`Auto-resuming from row ${currentCompleted + 1}...`);
        await processChunk(currentCompleted, effectiveJobId, "start");
      } else {
        try {
          const filename = await downloadStoredJobOutputOnce(effectiveJobId);
          setStatus(filename ? `IEHP processing completed. Download started for ${filename}.` : "IEHP processing completed.");
          await clearStoredRunContext().catch(() => {});
        } catch (postError) {
          console.error("IEHP output download failed", postError);
          setStatus(`IEHP processing completed, but automatic output download failed: ${getErrorMessage(postError)}`);
        } finally {
          setIsProcessing(false);
          setActiveJobId("");
        }
      }
    };

    await processChunk(options.initialStartIndex ?? 0, options.existingJobId ?? "", options.attachToRunningJob ? "attach" : "start");
    setActiveJobId("");
  }

  async function resumeExistingIehpRun(currentJob: CurrentScrapeJob, storedClaimHandle: FileSystemFileHandle, storedLoginFile: File) {
    if (currentJob.status === "waiting_resume") {
      await runIehpSession({
        claimFileHandle: storedClaimHandle,
        loginFile: storedLoginFile,
        existingJobId: currentJob.jobId,
        initialStartIndex: currentJob.currentCompleted,
        initialLogs: currentJob.logs,
        initialProgress:
          currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null,
      });
      return;
    }

    await runIehpSession({
      claimFileHandle: storedClaimHandle,
      loginFile: storedLoginFile,
      existingJobId: currentJob.jobId,
      initialStartIndex: currentJob.currentCompleted,
      attachToRunningJob: true,
      initialProgress:
        currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null,
    });
  }

  async function reconnectAerialRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setSelectedPortalId("aerial");
    setLogs([]);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    setStatus("Reconnecting to current Aerial run...");

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    const subscribedJobId = "";
    const streamAbortController = new AbortController();

    try {
      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          if (eventData.type === "log" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
          } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
            setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
          } else if (eventData.type === "row_progress" && typeof eventData.current === "number" && typeof eventData.total === "number") {
            setProgress({ completed: Math.max(0, eventData.current - 1), total: eventData.total, currentRow: eventData.current });
            setStatus(`Aerial processing row ${eventData.current} of ${eventData.total}: ${eventData.payerName || "Unknown payer"}${eventData.stage ? ` (${eventData.stage})` : ""}.`);
          } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
            setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(currentJob.jobId, artifactKey)) {
              downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
              rememberDownloadedArtifact(currentJob.jobId, artifactKey);
              setStatus(`Downloaded ${eventData.filename}`);
            }
          } else if (eventData.type === "warning" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
            setStatus(eventData.message);
          } else if (eventData.type === "error" && eventData.message) {
            finalErrorMessage = eventData.message;
            setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
            setStatus(`Error: ${eventData.message}`);
            hasError = true;
          } else if (eventData.type === "cancelled") {
            wasCancelled = true;
            setStatus(eventData.message || "Processing cancelled.");
            setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
          }
        },
        onStreamError(error) {
          console.error("Aerial stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      setStatus(
        wasCancelled
          ? "Aerial processing cancelled."
          : hasError
          ? `Aerial processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Aerial processing completed.",
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function reconnectDownloadOnlyRun(currentJob: CurrentScrapeJob, portalId: PortalId, portalName: string) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setSelectedPortalId(portalId);
    setLogs(currentJob.logs ?? []);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    const latestSnapshot = [...(currentJob.artifacts ?? [])]
      .reverse()
      .find((artifact) => artifact.artifactType === "output_snapshot" && artifact.contentBase64 && artifact.filename);
    if (portalId === "availity" && latestSnapshot?.contentBase64 && latestSnapshot.filename) {
      setLatestAvailityOutput({
        filename: latestSnapshot.filename,
        base64: latestSnapshot.contentBase64,
        mimeType: latestSnapshot.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: currentJob.currentCompleted,
        total: currentJob.totalRows,
      });
    }
    setStatus(`Reconnecting to current ${portalName} run...`);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    const streamAbortController = new AbortController();

    try {
      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          if (eventData.type === "log" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
          } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
            setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
          } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
            setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(currentJob.jobId, artifactKey)) {
              downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
              rememberDownloadedArtifact(currentJob.jobId, artifactKey);
              setStatus(`Downloaded ${eventData.filename}`);
            }
          } else if (eventData.type === "output_snapshot" && eventData.filename && eventData.base64) {
            if (portalId === "availity") {
              setLatestAvailityOutput({
                filename: eventData.filename,
                base64: eventData.base64,
                mimeType: eventData.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                completed: eventData.completed,
                total: eventData.total,
              });
            }
          } else if (eventData.type === "warning" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
            setStatus(eventData.message);
          } else if (eventData.type === "error" && eventData.message) {
            finalErrorMessage = eventData.message;
            setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
            setStatus(`Error: ${eventData.message}`);
            hasError = true;
          } else if (eventData.type === "cancelled") {
            wasCancelled = true;
            setStatus(eventData.message || "Processing cancelled.");
            setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
          }
        },
        onStreamError(error) {
          console.error(`${portalName} stream error:`, error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      setStatus(
        wasCancelled
          ? `${portalName} processing cancelled.`
          : hasError
          ? `${portalName} processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : `${portalName} processing completed.`,
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }



  async function reconnectBlueShieldRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setPendingBlueShieldRestoreJob(null);
    setSelectedPortalId("blue-shield");
    setBlueShieldJobId(currentJob.jobId);
    setLogs(currentJob.logs ?? []);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    setStatus("Reconnecting to current Blue Shield run...");

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    const streamAbortController = new AbortController();

    try {
      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          if (eventData.type === "log" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
          } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
            setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
          } else if (eventData.type === "input_request" && eventData.inputName) {
            setBlueShieldOtpRequest({
              inputName: eventData.inputName,
              label: eventData.label || "Enter verification code",
              message: eventData.message || "Enter the verification code sent by Blue Shield.",
            });
            setBlueShieldOtpValue("");
            setStatus(eventData.message || "Waiting for Blue Shield verification code.");
          } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
            setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(currentJob.jobId, artifactKey)) {
              downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
              rememberDownloadedArtifact(currentJob.jobId, artifactKey);
              setStatus(`Downloaded ${eventData.filename}`);
            }
          } else if (eventData.type === "warning" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
            setStatus(eventData.message);
          } else if (eventData.type === "error" && eventData.message) {
            finalErrorMessage = eventData.message;
            setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
            setStatus(`Error: ${eventData.message}`);
            hasError = true;
          } else if (eventData.type === "cancelled") {
            wasCancelled = true;
            setStatus(eventData.message || "Processing cancelled.");
            setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
          }
        },
        onStreamError(error) {
          console.error("Blue Shield stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      setStatus(
        wasCancelled
          ? "Blue Shield processing cancelled."
          : hasError
          ? `Blue Shield processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Blue Shield processing completed.",
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function reconnectRegalRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setSelectedPortalId("regal");
    setRegalJobId(currentJob.jobId);
    setLogs(currentJob.logs ?? []);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    for (const artifact of currentJob.artifacts ?? []) {
      if (artifact.artifactType !== "file_download" || !artifact.contentBase64 || !artifact.filename) continue;
      if (artifact.filename === "regal_output.xlsx") {
        setLatestRegalOutput({
          filename: artifact.filename,
          base64: artifact.contentBase64,
          mimeType: artifact.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          completed: currentJob.currentCompleted,
          total: currentJob.totalRows,
        });
      }
      const artifactKey = `restored|${artifact.id}|${artifact.filename}|${artifact.pathOrKey}`;
      if (!hasDownloadedArtifact(currentJob.jobId, artifactKey)) {
        downloadBase64File(artifact.filename, artifact.contentBase64, artifact.mimeType || "application/octet-stream");
        rememberDownloadedArtifact(currentJob.jobId, artifactKey);
      }
    }
    const latestSnapshot = [...(currentJob.artifacts ?? [])]
      .reverse()
      .find((artifact) => artifact.artifactType === "output_snapshot" && artifact.contentBase64 && artifact.filename);
    if (latestSnapshot?.contentBase64 && latestSnapshot.filename) {
      setLatestRegalOutput({
        filename: latestSnapshot.filename,
        base64: latestSnapshot.contentBase64,
        mimeType: latestSnapshot.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: currentJob.currentCompleted,
        total: currentJob.totalRows,
      });
    }
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    setStatus("Reconnecting to current Regal run...");

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    const diagnosticFiles: DownloadFile[] = [];
    const streamAbortController = new AbortController();

    try {
      if (currentJob.status === "waiting_resume") {
        if (!regalClaimFile) {
          setPendingRegalRestoreJob(currentJob);
          setStatus(`Previous Regal run paused at row ${currentJob.currentCompleted + 1}. Reselect the same Regal claim Excel and login Excel, then start again to continue.`);
          return;
        }

        const formData = new FormData();
        formData.append("portalId", "regal");
        formData.append("existingJobId", currentJob.jobId);
        formData.append("startIndex", String(currentJob.currentCompleted));
        if (regalLoginFile) {
          formData.append("loginExcel", regalLoginFile);
          formData.append("loginFileName", regalLoginFile.name);
        }
        formData.append("claimExcel", regalClaimFile);
        formData.append("claimFileName", regalClaimFile.name);
        await startScrapeJob(formData);
        setRegalLoginFile(null);
        setRegalClaimFile(null);
        void refreshWorkflowRuns({ silent: true });
      }

      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          await handleRegalJobEvent(eventData, currentJob.jobId, (message) => {
            finalErrorMessage = message;
            hasError = true;
          }, diagnosticFiles);
          if (eventData.type === "cancelled") {
            wasCancelled = true;
          }
        },
        onStreamError(error) {
          console.error("Regal stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      downloadZip(`regal-diagnostics-${currentJob.jobId}.zip`, diagnosticFiles);

      setStatus(
        wasCancelled
          ? "Regal processing cancelled."
          : hasError
          ? `Regal processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Regal processing completed.",
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function reconnectOptumProRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setSelectedPortalId("optum-pro");
    setOptumProJobId(currentJob.jobId);
    setOptumProStaleRunAvailable(false);
    setLogs(currentJob.logs ?? []);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    setStatus("Reconnecting to current Optum Pro processing run...");

    let hasError = false;
    let finalErrorMessage = "";
    const streamAbortController = new AbortController();

    try {
      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          await handleOptumProJobEvent(eventData, currentJob.jobId, (message) => {
            finalErrorMessage = message;
            hasError = true;
          });
        },
        onStreamError(error) {
          console.error("Optum Pro stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      setStatus(
        hasError
          ? `Optum Pro processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Optum Pro processing completed.",
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function handleRegalJobEvent(
    eventData: ScrapeJobEvent,
    jobId: string,
    onError: (message: string) => void,
    diagnosticFiles?: DownloadFile[],
  ) {
    if (eventData.type === "log" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
    } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
      setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
    } else if (eventData.type === "input_request" && eventData.inputName) {
      if (eventData.inputName === "regal_mfa_method") {
        const options = eventData.options ?? [];
        setRegalMfaRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Select Regal verification method",
          message: eventData.message || "Choose one available verification method.",
          options,
        });
        setRegalMfaValue(options.find((option) => !option.disabled)?.value ?? "");
      } else {
        setRegalOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Enter verification code",
          message: eventData.message || "Enter the verification code sent by Regal/Okta.",
        });
        setRegalOtpValue("");
      }
      setStatus(eventData.message || (eventData.inputName === "regal_mfa_method" ? "Waiting for Regal verification method selection." : "Waiting for Regal verification code."));
    } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
      setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (diagnosticFiles && !hasDownloadedArtifact(jobId, artifactKey)) {
        diagnosticFiles.push({
          filename: eventData.filename || `regal_error_screenshot_${eventData.index + 1}.jpg`,
          bytes: base64ToBytes(eventData.image),
        });
        rememberDownloadedArtifact(jobId, artifactKey);
      }
    } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
      if (eventData.filename === "regal_output.xlsx") {
        setLatestRegalOutput({
          filename: eventData.filename,
          base64: eventData.base64,
          mimeType: eventData.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          completed: eventData.completed,
          total: eventData.total,
        });
      }
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (!hasDownloadedArtifact(jobId, artifactKey)) {
        downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
        rememberDownloadedArtifact(jobId, artifactKey);
        setStatus(`Downloaded ${eventData.filename}`);
      }
    } else if (eventData.type === "output_snapshot" && eventData.filename && eventData.base64) {
      setLatestRegalOutput({
        filename: eventData.filename,
        base64: eventData.base64,
        mimeType: eventData.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: eventData.completed,
        total: eventData.total,
      });
    } else if (eventData.type === "debug_html" && typeof eventData.index === "number" && eventData.html) {
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (diagnosticFiles && !hasDownloadedArtifact(jobId, artifactKey)) {
        diagnosticFiles.push({
          filename: eventData.filename || `regal_error_page_${eventData.index + 1}.html`,
          bytes: textToBytes(eventData.html),
        });
        rememberDownloadedArtifact(jobId, artifactKey);
      }
    } else if (eventData.type === "warning" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
      setStatus(eventData.message);
    } else if (eventData.type === "cancelled" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
      setStatus(eventData.message);
    } else if (eventData.type === "error" && eventData.message) {
      onError(eventData.message);
      setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
      setStatus(`Error: ${eventData.message}`);
    } else if (eventData.type === "cancelled") {
      setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
      setStatus(eventData.message || "Processing cancelled.");
    }
  }

  async function handleOptumProJobEvent(
    eventData: ScrapeJobEvent,
    jobId: string,
    onError: (message: string) => void,
  ) {
    if (eventData.type === "log" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
    } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
      setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
    } else if (eventData.type === "job_metadata") {
      const metadata = eventData as Record<string, unknown>;
      if (typeof metadata.processedRows !== "number" || typeof metadata.totalRows !== "number") return;
      setProgress({ completed: metadata.processedRows, total: metadata.totalRows });
      if (Boolean(metadata.stopped) && Boolean(metadata.partialOutputAvailable)) {
        setStatus(`Stopped. Partial Excel ready for ${metadata.processedRows} of ${metadata.totalRows} rows.`);
      }
    } else if (eventData.type === "input_request" && eventData.inputName) {
      setOptumProOtpRequest({
        inputName: eventData.inputName,
        label: eventData.label || "Enter Optum Pro verification code",
        message: eventData.message || "Enter the One Healthcare ID text-message OTP.",
      });
      setOptumProOtpValue("");
      setStatus(eventData.message || "Waiting for Optum Pro verification code.");
    } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
      setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
    } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (!hasDownloadedArtifact(jobId, artifactKey)) {
        downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
        rememberDownloadedArtifact(jobId, artifactKey);
        setStatus(
          String(eventData.filename).includes("partial")
            ? `Partial Excel downloaded: ${eventData.filename}`
            : `Downloaded ${eventData.filename}`,
        );
      }
    } else if (eventData.type === "debug_html" && typeof eventData.index === "number" && eventData.html) {
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (!hasDownloadedArtifact(jobId, artifactKey)) {
        downloadTextFile(eventData.filename || `optum_pro_debug_${eventData.index + 1}.html`, eventData.html, "text/html");
        rememberDownloadedArtifact(jobId, artifactKey);
      }
    } else if (eventData.type === "warning" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
      setStatus(eventData.message);
    } else if (eventData.type === "cancelled") {
      const message = eventData.message || "Optum Pro scraping stopped.";
      setOptumProStopping(false);
      setOptumProStaleRunAvailable(false);
      setIsProcessing(false);
      setOptumProOtpRequest(null);
      setLogs((prev) => [...prev, message]);
      setStatus(String(message).startsWith("Stopped") ? message : `Stopped. ${message}`);
    } else if (eventData.type === "error" && eventData.message) {
      onError(eventData.message);
      setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
      setStatus(`Error: ${eventData.message}`);
    }
  }

  async function submitIehp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!iehpLoginFile || !claimFileHandle) {
      setStatus("Please provide both required files.");
      return;
    }

    const resumeJob = pendingIehpRestoreJob;

    try {
      if (resumeJob) {
        setPendingIehpRestoreJob(null);
        setIsProcessing(true);
        setStatus(`Resuming previous IEHP run from row ${resumeJob.currentCompleted + 1}...`);
        await resumeExistingIehpRun(resumeJob, claimFileHandle, iehpLoginFile);
        return;
      }

      resetRunState("Reading claim file...");
      await runIehpSession({
        claimFileHandle,
        loginFile: iehpLoginFile,
      });
    } catch (error) {
      if (resumeJob) {
        setPendingIehpRestoreJob(resumeJob);
      }
      setStatus(`Failed to process IEHP claims: ${getErrorMessage(error)}`);
      setIsProcessing(false);
    }
  }

  async function submitAerial(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!aerialInputFile) {
      setStatus("Please provide the Aerial input Excel file.");
      return;
    }

    if (!aerialSubportal) {
      setStatus("Please select PMG or Citrus Valley.");
      return;
    }

    const subportalDefinition = getAerialSubportal(aerialSubportal);
    if (subportalDefinition?.requiresCredentialFile && !aerialCredentialFile) {
      setStatus(`Please provide the Aerial login Excel containing the ${subportalDefinition.label} row.`);
      return;
    }

    resetRunState("Starting Aerial scraper...");

    const formData = new FormData();
    formData.append("portalId", "aerial");
    formData.append("aerialSubportal", aerialSubportal);
    if (aerialCredentialFile) {
      formData.append("credentialExcel", aerialCredentialFile);
      formData.append("loginFileName", aerialCredentialFile.name);
    }
    formData.append("inputExcel", aerialInputFile);
    formData.append("claimFileName", aerialInputFile.name);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
      } else if (eventData.type === "row_progress" && typeof eventData.current === "number" && typeof eventData.total === "number") {
        setProgress({ completed: Math.max(0, eventData.current - 1), total: eventData.total, currentRow: eventData.current });
        setStatus(`Availity processing row ${eventData.current} of ${eventData.total}: ${eventData.payerName || "Unknown payer"}${eventData.stage ? ` (${eventData.stage})` : ""}.`);
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "otp_request" && eventData.inputName) {
        setAvailityOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Availity OTP",
          message: eventData.message || "Enter the Availity verification code.",
        });
        setAvailityOtpValue("");
        setStatus(eventData.message || "Enter the Availity verification code.");
      } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
        const artifactKey = buildDownloadArtifactKey(eventData);
        if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
          downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
          rememberDownloadedArtifact(subscribedJobId, artifactKey);
          setStatus(`Downloaded ${eventData.filename}`);
        }
      } else if (eventData.type === "output_snapshot" && eventData.filename && eventData.base64) {
        setLatestAvailityOutput({
          filename: eventData.filename,
          base64: eventData.base64,
          mimeType: eventData.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          completed: eventData.completed,
          total: eventData.total,
        });
      } else if (eventData.type === "warning" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
        setStatus(eventData.message);
      } else if (eventData.type === "error" && eventData.message) {
        finalErrorMessage = eventData.message;
        setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
        setStatus(`Error: ${eventData.message}`);
        hasError = true;
      } else if (eventData.type === "cancelled") {
        wasCancelled = true;
        setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
        setStatus(eventData.message || "Processing cancelled.");
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setActiveJobId(jobId);
      setAvailityJobId(jobId);
      setAerialCredentialFile(null);
      setAerialInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Aerial stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "Aerial processing cancelled."
          : hasError
          ? `Aerial processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Aerial processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Aerial claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
      setAvailityJobId("");
    }
  }

  async function submitWaystar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!waystarLoginFile || !waystarInputFile) {
      setStatus("Please provide both the Waystar login Excel and claim Excel files.");
      return;
    }
    resetRunState("Starting Waystar processing...");
    const formData = new FormData();
    formData.append("portalId", "waystar");
    formData.append("loginExcel", waystarLoginFile);
    formData.append("inputExcel", waystarInputFile);
    formData.append("loginFileName", waystarLoginFile.name);
    formData.append("claimFileName", waystarInputFile.name);
    await runStandardPortalJob({
      portalName: "Waystar",
      formData,
      clearFiles: () => { setWaystarLoginFile(null); setWaystarInputFile(null); },
      progressMessage: (completed, total) => `Waystar processing ${completed} of ${total} row(s)...`,
    });
  }
  async function submitKaiser(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!kaiserCredentialFile || !kaiserInputFile) {
      setStatus("Please provide both the Kaiser login Excel and claim Excel files.");
      return;
    }
    resetRunState("Starting Kaiser scraper...");
    const formData = new FormData();
    formData.append("portalId", "kaiser");
    formData.append("credentialExcel", kaiserCredentialFile);
    formData.append("inputExcel", kaiserInputFile);
    formData.append("loginFileName", kaiserCredentialFile.name);
    formData.append("claimFileName", kaiserInputFile.name);
    await runStandardPortalJob({
      portalName: "Kaiser",
      formData,
      clearFiles: () => { setKaiserCredentialFile(null); setKaiserInputFile(null); },
    });
  }
  async function submitCigna(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!cignaCredentialFile || !cignaInputFile) {
      setStatus("Please provide both the Cigna login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting Cigna scraper...");

    const formData = new FormData();
    formData.append("portalId", "cigna");
    formData.append("credentialExcel", cignaCredentialFile);
    formData.append("inputExcel", cignaInputFile);
    formData.append("loginFileName", cignaCredentialFile.name);
    formData.append("claimFileName", cignaInputFile.name);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total });
      } else if (eventData.type === "input_request" && eventData.inputName) {
        setCignaOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Cigna verification code",
          message: eventData.message || "Enter the 6-digit Cigna email verification code.",
        });
        setCignaOtpValue("");
        setStatus(eventData.message || "Waiting for Cigna verification code.");
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
        const artifactKey = buildDownloadArtifactKey(eventData);
        if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
          downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
          rememberDownloadedArtifact(subscribedJobId, artifactKey);
          setStatus(`Downloaded ${eventData.filename}`);
        }
      } else if (eventData.type === "warning" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
        setStatus(eventData.message);
      } else if (eventData.type === "error" && eventData.message) {
        finalErrorMessage = eventData.message;
        setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
        setStatus(`Error: ${eventData.message}`);
        hasError = true;
      } else if (eventData.type === "cancelled") {
        wasCancelled = true;
        setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
        setStatus(eventData.message || "Processing cancelled.");
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setCignaJobId(jobId);
      setActiveJobId(jobId);
      setCignaCredentialFile(null);
      setCignaInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Cigna stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "Cigna processing cancelled."
          : hasError
            ? `Cigna processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
            : "Cigna processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Cigna claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitCignaOtp() {
    if (!cignaJobId || !cignaOtpRequest || !cignaOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: cignaJobId,
        inputName: cignaOtpRequest.inputName,
        value: cignaOtpValue.trim(),
      });
      setCignaOtpRequest(null);
      setCignaOtpValue("");
      setStatus("Cigna verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Cigna OTP: ${getErrorMessage(error)}`);
    }
  }

  async function submitMyFamily(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!myFamilyCredentialFile || !myFamilyInputFile) {
      setStatus("Please provide both the My family login Excel and claim Excel files.");
      return;
    }
    resetRunState("Starting My family scraper...");
    const formData = new FormData();
    formData.append("portalId", "my-family");
    formData.append("credentialExcel", myFamilyCredentialFile);
    formData.append("inputExcel", myFamilyInputFile);
    formData.append("loginFileName", myFamilyCredentialFile.name);
    formData.append("claimFileName", myFamilyInputFile.name);
    await runStandardPortalJob({
      portalName: "My family",
      formData,
      clearFiles: () => { setMyFamilyCredentialFile(null); setMyFamilyInputFile(null); },
    });
  }
  async function submitPhysicians(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!physiciansCredentialFile || !physiciansInputFile) {
      setStatus("Please provide both the Physicians login Excel and claim Excel files.");
      return;
    }
    resetRunState("Starting Physicians scraper...");
    const formData = new FormData();
    formData.append("portalId", "physicians");
    formData.append("credentialExcel", physiciansCredentialFile);
    formData.append("inputExcel", physiciansInputFile);
    formData.append("loginFileName", physiciansCredentialFile.name);
    formData.append("claimFileName", physiciansInputFile.name);
    await runStandardPortalJob({
      portalName: "Physicians",
      formData,
      clearFiles: () => { setPhysiciansCredentialFile(null); setPhysiciansInputFile(null); },
    });
  }
  async function submitAstrona(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const isAllCare = effectivePortalId === "all-care";
    const credentialFile = isAllCare ? allCareCredentialFile : astronaCredentialFile;
    const inputFile = isAllCare ? allCareInputFile : astronaInputFile;
    const portalId = isAllCare ? "all-care" : "astrona";
    const portalName = isAllCare ? "All Care" : "Astrona";
    if (!credentialFile || !inputFile) {
      setStatus(`Please provide both the ${portalName} login Excel and claim Excel files.`);
      return;
    }

    resetRunState(`Starting ${portalName} scraper...`);
    const formData = new FormData();
    formData.append("portalId", portalId);
    formData.append("credentialExcel", credentialFile);
    formData.append("inputExcel", inputFile);
    formData.append("loginFileName", credentialFile.name);
    formData.append("claimFileName", inputFile.name);
    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setActiveJobId(jobId);
      if (isAllCare) {
        setAllCareCredentialFile(null);
        setAllCareInputFile(null);
      } else {
        setAstronaCredentialFile(null);
        setAstronaInputFile(null);
      }
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          if (eventData.type === "log" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
            setStatus(eventData.message);
          }
          else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
          else if (eventData.type === "astrona_result" && eventData.rows?.length) setAstronaResults((previous) => [...previous, ...(eventData.rows ?? [])]);
          else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
              downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
              rememberDownloadedArtifact(subscribedJobId, artifactKey);
              setStatus(`Downloaded ${eventData.filename}`);
            }
          } else if (eventData.type === "warning" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
            setStatus(eventData.message);
          } else if (eventData.type === "error" && eventData.message) {
            hasError = true;
            finalErrorMessage = eventData.message;
            setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
          } else if (eventData.type === "cancelled") wasCancelled = true;
        },
        onStreamError(error) {
          hasError = true;
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
        },
      });
      setStatus(wasCancelled ? `${portalName} processing cancelled.` : hasError ? `${portalName} processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}` : `${portalName} processing completed.`);
    } catch (error) {
      setStatus(`Failed to process ${portalName} claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  function submitAllCare(e: FormEvent<HTMLFormElement>) {
    void submitAstrona(e);
  }

  async function submitBlueShield(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!blueShieldCredentialFile || !blueShieldInputFile) {
      setStatus("Please provide both the Blue Shield login Excel and input Excel files.");
      return;
    }

    const activeBlueShieldJob = pendingBlueShieldRestoreJob
      ?? await getCurrentScrapeJob().then((job) => (job?.portalId === "blue-shield" && (job.status === "running" || job.status === "waiting_resume") ? job : null)).catch(() => null);

    if (activeBlueShieldJob) {
      setStatus("Replacing previous Blue Shield run and starting a new one...");
      try {
        await cancelScrapeJobRequest(activeBlueShieldJob.jobId);
      } catch (error) {
        setStatus(`Failed to replace previous Blue Shield run: ${getErrorMessage(error)}`);
        return;
      }
    }

    setPendingBlueShieldRestoreJob(null);
    resetRunState(activeBlueShieldJob ? "Starting new Blue Shield scraper..." : "Starting Blue Shield scraper...");

    const formData = new FormData();
    formData.append("portalId", "blue-shield");
    formData.append("credentialExcel", blueShieldCredentialFile);
    formData.append("inputExcel", blueShieldInputFile);
    formData.append("loginFileName", blueShieldCredentialFile.name);
    formData.append("claimFileName", blueShieldInputFile.name);
    formData.append("checkpointId", blueShieldInputFile.name || "blue-shield");
    formData.append("resetCheckpoint", blueShieldResetCheckpoint ? "true" : "false");

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
      } else if (eventData.type === "input_request" && eventData.inputName) {
        setBlueShieldOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Enter verification code",
          message: eventData.message || "Enter the verification code sent by Blue Shield.",
        });
        setBlueShieldOtpValue("");
        setStatus(eventData.message || "Waiting for Blue Shield verification code.");
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
        const artifactKey = buildDownloadArtifactKey(eventData);
        if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
          downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
          rememberDownloadedArtifact(subscribedJobId, artifactKey);
          setStatus(`Downloaded ${eventData.filename}`);
        }
      } else if (eventData.type === "warning" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
        setStatus(eventData.message);
      } else if (eventData.type === "error" && eventData.message) {
        finalErrorMessage = eventData.message;
        setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
        setStatus(`Error: ${eventData.message}`);
        hasError = true;
      } else if (eventData.type === "cancelled") {
        wasCancelled = true;
        setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
        setStatus(eventData.message || "Processing cancelled.");
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setBlueShieldJobId(jobId);
      setActiveJobId(jobId);
      setBlueShieldCredentialFile(null);
      setBlueShieldInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Blue Shield stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "Blue Shield processing cancelled."
          : hasError
          ? `Blue Shield processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Blue Shield processing completed.",
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const currentJob = await getCurrentScrapeJob().catch(() => null);

      if (currentJob?.portalId === "blue-shield" && (currentJob.status === "running" || currentJob.status === "waiting_resume")) {
        setActiveJobId(currentJob.jobId);
        setPendingBlueShieldRestoreJob(currentJob);
        setSelectedPortalId("blue-shield");
        setStatus("A previous Blue Shield run is still active. Use the active-runs table to view or cancel that specific run.");
      } else {
        setStatus(`Failed to process Blue Shield claims: ${errorMessage}`);
      }
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitBlueShieldOtp() {
    if (!blueShieldJobId || !blueShieldOtpRequest || !blueShieldOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: blueShieldJobId,
        inputName: blueShieldOtpRequest.inputName,
        value: blueShieldOtpValue.trim(),
      });
      setBlueShieldOtpRequest(null);
      setBlueShieldOtpValue("");
      setStatus("Blue Shield verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Blue Shield OTP: ${getErrorMessage(error)}`);
    }
  }

  async function submitRegal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!regalClaimFile) {
      setStatus("Please provide the Regal claim Excel file.");
      return;
    }

    resetRunState("Starting Regal scraper...");

    const formData = new FormData();
    formData.append("portalId", "regal");
    if (pendingRegalRestoreJob) {
      formData.append("existingJobId", pendingRegalRestoreJob.jobId);
      formData.append("startIndex", String(pendingRegalRestoreJob.currentCompleted));
    }
    if (regalLoginFile) {
      formData.append("loginExcel", regalLoginFile);
      formData.append("loginFileName", regalLoginFile.name);
    }
    formData.append("claimExcel", regalClaimFile);
    formData.append("claimFileName", regalClaimFile.name);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    const diagnosticFiles: DownloadFile[] = [];
    const streamAbortController = new AbortController();

    try {
      const jobId = await startScrapeJob(formData);
      setPendingRegalRestoreJob(null);
      setRegalJobId(jobId);
      setActiveJobId(jobId);
      setRegalLoginFile(null);
      setRegalClaimFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          await handleRegalJobEvent(eventData, jobId, (message) => {
            finalErrorMessage = message;
            hasError = true;
          }, diagnosticFiles);
          if (eventData.type === "cancelled") {
            wasCancelled = true;
          }
        },
        onStreamError(error) {
          console.error("Regal stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      downloadZip(`regal-diagnostics-${jobId}.zip`, diagnosticFiles);
      setStatus(
        wasCancelled
          ? "Regal processing cancelled."
          : hasError
          ? `Regal processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Regal processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Regal claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitRegalOtp() {
    if (!regalJobId || !regalOtpRequest || !regalOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: regalJobId,
        inputName: regalOtpRequest.inputName,
        value: regalOtpValue.trim(),
      });
      setRegalOtpRequest(null);
      setRegalOtpValue("");
      setStatus("Regal verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Regal OTP: ${getErrorMessage(error)}`);
    }
  }

  async function submitRegalMfaMethod() {
    if (!regalJobId || !regalMfaRequest || !regalMfaValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: regalJobId,
        inputName: regalMfaRequest.inputName,
        value: regalMfaValue.trim(),
      });
      setRegalMfaRequest(null);
      setRegalMfaValue("");
      setStatus("Regal verification method submitted.");
    } catch (error) {
      setStatus(`Failed to submit Regal verification method: ${getErrorMessage(error)}`);
    }
  }

  async function submitOptumPro(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!optumProLoginFile || !optumProInputFile) {
      setStatus("Please provide both the Optum Pro login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting Optum Pro processing...");
    setOptumProStopping(false);
    setOptumProStaleRunAvailable(false);

    const formData = new FormData();
    formData.append("portalId", "optum-pro");
    formData.append("loginExcel", optumProLoginFile);
    formData.append("inputExcel", optumProInputFile);
    formData.append("loginFileName", optumProLoginFile.name);
    formData.append("claimFileName", optumProInputFile.name);

    let hasError = false;
    let finalErrorMessage = "";
    const streamAbortController = new AbortController();

    try {
      const jobId = await startScrapeJob(formData);
      setOptumProJobId(jobId);
      setActiveJobId(jobId);
      setOptumProLoginFile(null);
      setOptumProInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          await handleOptumProJobEvent(eventData, jobId, (message) => {
            finalErrorMessage = message;
            hasError = true;
          });
        },
        onStreamError(error) {
          console.error("Optum Pro stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        hasError
          ? `Optum Pro processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Optum Pro processing completed.",
      );
    } catch (error) {
      const existingJobId = getActiveScrapeJobErrorId(error);
      if (existingJobId) {
        setOptumProJobId(existingJobId);
        setOptumProStaleRunAvailable(true);
        setStatus(`Failed to process Optum Pro claims: ${getErrorMessage(error)} Use Stop Optum Pro scraping to cancel that active run.`);
      } else {
        setStatus(`Failed to process Optum Pro claims: ${getErrorMessage(error)}`);
      }
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
      setOptumProStopping(false);
    }
  }

  async function stopOptumPro() {
    if (!optumProJobId || optumProStopping) return;

    setOptumProStopping(true);
    setStatus("Stopping Optum Pro scraping...");
    try {
      await cancelScrapeJobRequest(optumProJobId);
      setOptumProStaleRunAvailable(false);
      setOptumProOtpRequest(null);
      setOptumProOtpValue("");
      setStatus("Stop requested for Optum Pro scraping.");
    } catch (error) {
      setOptumProStopping(false);
      setStatus(`Failed to stop Optum Pro scraping: ${getErrorMessage(error)}`);
    }
  }

  async function submitOptumProOtp() {
    if (!optumProJobId || !optumProOtpRequest || !optumProOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: optumProJobId,
        inputName: optumProOtpRequest.inputName,
        value: optumProOtpValue.trim(),
      });
      setOptumProOtpRequest(null);
      setOptumProOtpValue("");
      setStatus("Optum Pro verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Optum Pro OTP: ${getErrorMessage(error)}`);
    }
  }

  function downloadLatestRegalOutput() {
    if (!latestRegalOutput) return;
    const completedSuffix = typeof latestRegalOutput.completed === "number" && typeof latestRegalOutput.total === "number"
      ? `-${latestRegalOutput.completed}-of-${latestRegalOutput.total}`
      : "";
    const filename = latestRegalOutput.filename === "regal_output_snapshot.xlsx"
      ? `regal_output_partial${completedSuffix}.xlsx`
      : latestRegalOutput.filename;
    downloadBase64File(filename, latestRegalOutput.base64, latestRegalOutput.mimeType);
  }

  const workflowRunsPanel = (
    <WorkflowRunsPanel
      enabled={workflowRunTrackingEnabled}
      runningCount={runningWorkflowRunCount}
      jobs={visibleWorkflowRuns}
      loading={workflowRunsLoading}
      error={workflowRunsError}
      selectedJobId={selectedWorkflowRunId}
      downloadingJobId={downloadingWorkflowJobId}
      cancellingJobId={cancellingWorkflowJobId}
      onRefresh={refreshWorkflowRuns}
      onSelect={selectWorkflowRun}
      onDownload={downloadWorkflowRun}
      onCancel={cancelWorkflowRun}
    />
  );
  const operationsRunningJobsPanel = (
    <OperationsRunningJobsPanel
      enabled={canViewOperationsRunningJobs}
      jobs={operationsRunningJobs}
      loading={operationsRunningJobsLoading}
      error={operationsRunningJobsError}
      selectedJobId={selectedWorkflowRunId}
      cancellingJobId={cancellingWorkflowJobId}
      forceStoppingJobId={forceStoppingWorkflowJobId}
      onRefresh={refreshOperationsRunningJobs}
      onSelect={selectWorkflowRun}
      onCancel={cancelWorkflowRun}
      onForceStop={forceStopWorkflowRun}
    />
  );

  const outputsPanel = (
    <OutputsPanel
      enabled={workflowRunTrackingEnabled}
      jobs={outputWorkflowRuns}
      loading={workflowRunsLoading}
      error={workflowRunsError}
      downloadingJobId={downloadingWorkflowJobId}
      onRefresh={refreshWorkflowRuns}
      onDownload={downloadWorkflowRun}
    />
  );

  if (authLoading && !authUser) {
    return null;
  }

  if (!authUser) {
    return (
      <LoginView
        isProtectedRoute={isProtectedRoute}
        forgotPasswordMode={forgotPasswordMode}
        authUsername={authUsername}
        authPassword={authPassword}
        authConfirmPassword={authConfirmPassword}
        authError={authError}
        authStatus={authStatus}
        authSubmitting={authSubmitting}
        setAuthUsername={setAuthUsername}
        setAuthPassword={setAuthPassword}
        setAuthConfirmPassword={setAuthConfirmPassword}
        onAuthSubmit={onAuthSubmit}
        onForgotPasswordSubmit={onForgotPasswordSubmit}
        onShowForgotPassword={() => {
          setForgotPasswordMode(true);
          setAuthError("");
          setAuthStatus("");
          setAuthPassword("");
          setAuthConfirmPassword("");
        }}
        onBackToLogin={() => {
          setForgotPasswordMode(false);
          setAuthError("");
          setAuthStatus("");
          setAuthPassword("");
          setAuthConfirmPassword("");
        }}
      />
    );
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.98)_0%,_rgba(240,246,255,0.98)_44%,_rgba(227,238,255,0.95)_100%)] text-slate-900">
      <ClaimStatusTopNav
        userLabel={authUser.email || authUser.username}
        hasSelectedPortal={Boolean(effectivePortalId)}
        onResetPortal={resetPortalSelection}
        onBack={() => {
          if (effectivePortalId) resetPortalSelection();
          else router.push("/portal");
        }}
      />

      <div className="mx-auto w-full max-w-[96rem] px-3 py-8 sm:px-4 xl:px-5">
        <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)]">
          <ClaimStatusSidebar
            activeView={activeView}
            hasSelectedPortal={Boolean(effectivePortalId)}
            mustResetPassword={authUser.mustResetPassword}
            hasFullAccess={hasFullWorkflowAccess(authUser)}
            processingBlocked={blockPortalFormForProcessing}
            onDashboard={() => { setActiveView("portal-selection"); router.push("/portal"); }}
            onOutputs={() => { setActiveView("outputs"); void refreshWorkflowRuns(); }}
            onChangePortal={resetPortalSelection}
            onResetPassword={openResetPassword}
            onManageUsers={openManageUsers}
            onLogout={logout}
          />

          <div className="min-w-0">
        {activeView === "outputs" ? (
          outputsPanel
        ) : activeView === "reset-password" ? (
          <ResetPasswordView
            mustResetPassword={authUser.mustResetPassword}
            password={settingsPassword}
            confirmPassword={settingsConfirmPassword}
            error={settingsPasswordError}
            status={settingsPasswordStatus}
            submitting={settingsPasswordSubmitting}
            setPassword={setSettingsPassword}
            setConfirmPassword={setSettingsConfirmPassword}
            onSubmit={resetPasswordFromSettings}
            onBack={() => { setActiveView("portal-selection"); setSettingsOpen(false); }}
          />
        ) : activeView === "manage-users" && hasFullWorkflowAccess(authUser) ? (
          <ManageUsersView
            currentUserId={authUser.userId}
            tab={manageTab}
            setTab={setManageTab}
            error={manageError}
            status={manageStatus}
            newUserEmail={newUserEmail}
            temporaryPassword={temporaryPassword}
            setNewUserEmail={setNewUserEmail}
            setTemporaryPassword={setTemporaryPassword}
            users={managedUsers}
            editingUserId={editingUserId}
            editingEmail={editingEmail}
            setEditingUserId={setEditingUserId}
            setEditingEmail={setEditingEmail}
            onAdd={addManagedUser}
            onUpdateEmail={updateUserEmail}
            onDeactivate={deactivateUser}
            onBack={() => setActiveView("portal-selection")}
          />
        ) : (
          <div className="mx-auto w-full max-w-5xl rounded-[2rem] border border-sky-100 bg-white/86 p-6 shadow-[0_24px_80px_rgba(148,163,184,0.16)] backdrop-blur-xl md:p-8">
            {!selectedPortal ? (
            <>
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Multi-Portal Dashboard</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-3 rounded-[1rem] border border-sky-100 bg-white/95 px-3 py-2 shadow-[0_10px_24px_rgba(148,163,184,0.08)]">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[linear-gradient(135deg,#dbeafe_0%,#bfdbfe_100%)] text-xs font-semibold text-blue-700">
                      {userInitials || "AF"}
                    </div>
                    <div className="hidden sm:block">
                      <p className="text-sm font-semibold text-slate-900">{userDisplayName || "Afrin"}</p>
                      <p className="text-[0.7rem] text-slate-500">{formatUserRole(authUser.role)}</p>
                    </div>
                  </div>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                className="relative overflow-hidden rounded-[1.7rem] border border-sky-100 bg-[linear-gradient(135deg,rgba(239,246,255,0.96)_0%,rgba(221,235,255,0.82)_50%,rgba(255,255,255,0.94)_100%)] px-6 py-7 shadow-[0_18px_44px_rgba(148,163,184,0.12)]"
              >
                <div className="max-w-[25rem]">
                  <h1 className="text-[2rem] font-semibold tracking-[-0.05em] text-slate-950">
                    Welcome Back, <span className="text-[#2563EB]">{userDisplayName || "Afrin"}</span> ðŸ‘‹
                  </h1>
                  <p className="mt-3 max-w-md text-sm leading-6 text-slate-600">
                    Select a healthcare payer portal to automate claim status verification.
                  </p>
                </div>
                <div className="pointer-events-none absolute right-0 top-0 hidden h-full w-[40%] overflow-hidden rounded-l-[1.6rem] border-l border-sky-100/70 bg-white/35 shadow-[0_18px_42px_rgba(59,130,246,0.12)] lg:block">
                  <Image
                    src={dashboardWelcomeImage}
                    alt="Medical clipboard illustration"
                    fill
                    className="object-cover object-center opacity-100 scale-[1.08]"
                  />
                  <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(244,248,255,0.12)_0%,rgba(244,248,255,0)_22%,rgba(244,248,255,0)_100%)]" />
                </div>
              </motion.div>

              <PortalDirectory
                workflowRunsPanel={workflowRunsPanel}
                operationsRunningJobsPanel={operationsRunningJobsPanel}
                portalSearch={portalSearch}
                setPortalSearch={setPortalSearch}
                filterMenuOpen={filterMenuOpen}
                setFilterMenuOpen={setFilterMenuOpen}
                portalFilter={portalFilter}
                setPortalFilter={setPortalFilter}
                availablePortals={availablePortals}
                filteredPortals={filteredPortals}
                portalSort={portalSort}
                setPortalSort={setPortalSort}
                portalLayout={portalLayout}
                onPortalSelect={(portalId) => {
                  navigateToPortalRoute(portalId);
                  setStatus("");
                  setLogs([]);
                  setErrorScreenshots([]);
                  setProgress(null);
                  setAstronaResults([]);
                }}
              />
            </>
            ) : (
            <>
              <PortalWorkspaceHeader
                portalName={selectedPortal.name}
                portalUiMeta={selectedPortalUiMeta}
                steps={portalWorkflowSteps}
                stepIndex={portalWorkflowStepIndex}
                workflowRunsPanel={workflowRunsPanel}
              />

              <div className="mt-5">
                <div className="rounded-[1.7rem] border border-indigo-200 bg-gradient-to-br from-white via-white to-indigo-50/60 p-5 shadow-[0_18px_42px_rgba(79,70,229,0.10)] ring-1 ring-indigo-100/70">
                  <div className="mb-5 border-b border-indigo-100 pb-4">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-indigo-600">Portal Workflow</p>
                  </div>

                  {effectivePortalId === "blue-shield" && hasCompletedRun ? (
<div className="rounded-[1.2rem] border border-emerald-100 bg-emerald-50/70 p-5">
                      <p className="text-sm font-semibold text-emerald-800">Blue Shield processing is complete.</p>
                      <p className="mt-2 text-sm text-emerald-700">{status}</p>
                      <button
                        type="button"
                        onClick={resetBlueShieldWorkflow}
                        className="mt-4 inline-flex items-center justify-center rounded-[1rem] border border-emerald-200 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-50"
                      >
                        Start Another Run
                      </button>
                    </div>
                  ) : (
                    <PortalFormRenderer
                      portalId={effectivePortalId}
                      forms={{
                      "iehp": (
<IehpInputForm
                      canSubmit={canSubmitIehp}
                      claimFileName={claimFileName}
                      isProcessing={blockPortalFormForProcessing}
                      isResumePending={Boolean(pendingIehpRestoreJob)}
                      loginFileName={iehpLoginFile?.name ?? ""}
                      onLoginFileChange={handleLoginFileChange}
                      onSelectClaimFile={selectClaimFile}
                      onSubmit={submitIehp}
                    />
                      ),
                      "aerial": (
<AerialInputForm
                      canSubmit={canSubmitAerial}
                      credentialFileName={aerialCredentialFile?.name ?? ""}
                      inputFileName={aerialInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      selectedSubportal={aerialSubportal}
                      onCredentialFileChange={setAerialCredentialFile}
                      onInputFileChange={setAerialInputFile}
                      onSubportalChange={setAerialSubportal}
                      onSubmit={submitAerial}
                    />
                      ),
                      "regal": (
<RegalInputForm
                      canSubmit={canSubmitRegal}
                      claimFileName={regalClaimFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      loginFileName={regalLoginFile?.name ?? ""}
                      onClaimFileChange={setRegalClaimFile}
                      onLoginFileChange={setRegalLoginFile}
                      onSubmit={submitRegal}
                    />
                      ),
                      "availity": (
<AvailityInputForm
                      canSubmit={canSubmitAvaility}
                      credentialFileName={availityCredentialFile?.name ?? ""}
                      inputFileName={availityInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      selectedProjectId={availityProjectId}
                      onCredentialFileChange={setAvailityCredentialFile}
                      onInputFileChange={setAvailityInputFile}
                      onProjectChange={setAvailityProjectId}
                      onSubmit={submitAvaility}
                    />
                      ),
                      "uhc": (
<UhcInputForm
                      browserType={uhcBrowserType}
                      canSubmit={canSubmitUhc}
                      claimFileName={uhcClaimFileName}
                      groupId={uhcGroupId}
                      isProcessing={blockPortalFormForProcessing}
                      loginFileName={uhcLoginFile?.name ?? ""}
                      onBrowserTypeChange={setUhcBrowserType}
                      onClaimFileSelect={selectUhcClaimFile}
                      onGroupChange={setUhcGroupId}
                      onLoginFileChange={setUhcLoginFile}
                      onSubmit={submitUhc}
                    />
                      ),
                      "astrona": (
<AstronaInputForm
                      canSubmit={canSubmitAstrona}
                      credentialFileName={astronaCredentialFile?.name ?? ""}
                      inputFileName={astronaInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setAstronaCredentialFile}
                      onInputFileChange={setAstronaInputFile}
                      onSubmit={submitAstrona}
                    />
                      ),
                      "all-care": (
<AllCareInputForm
                      canSubmit={canSubmitAllCare}
                      credentialFileName={allCareCredentialFile?.name ?? ""}
                      inputFileName={allCareInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setAllCareCredentialFile}
                      onInputFileChange={setAllCareInputFile}
                      onSubmit={submitAllCare}
                    />
                      ),
                      "cigna": (
<CignaInputForm
                      canSubmit={canSubmitCigna}
                      credentialFileName={cignaCredentialFile?.name ?? ""}
                      inputFileName={cignaInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setCignaCredentialFile}
                      onInputFileChange={setCignaInputFile}
                      onSubmit={submitCigna}
                    />
                      ),
                      "kaiser": (
<KaiserInputForm
                      canSubmit={canSubmitKaiser}
                      credentialFileName={kaiserCredentialFile?.name ?? ""}
                      inputFileName={kaiserInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setKaiserCredentialFile}
                      onInputFileChange={setKaiserInputFile}
                      onSubmit={submitKaiser}
                    />
                      ),
                      "my-family": (
<MyFamilyInputForm
                      canSubmit={canSubmitMyFamily}
                      credentialFileName={myFamilyCredentialFile?.name ?? ""}
                      inputFileName={myFamilyInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setMyFamilyCredentialFile}
                      onInputFileChange={setMyFamilyInputFile}
                      onSubmit={submitMyFamily}
                    />
                      ),
                      "physicians": (
<PhysiciansInputForm
                      canSubmit={canSubmitPhysicians}
                      credentialFileName={physiciansCredentialFile?.name ?? ""}
                      inputFileName={physiciansInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setPhysiciansCredentialFile}
                      onInputFileChange={setPhysiciansInputFile}
                      onSubmit={submitPhysicians}
                    />
                      ),
                      "optum-pro": (
<OptumProInputForm
                      canSubmit={canSubmitOptumPro}
                      inputFileName={optumProInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      loginFileName={optumProLoginFile?.name ?? ""}
                      onInputFileChange={setOptumProInputFile}
                      onLoginFileChange={setOptumProLoginFile}
                      onSubmit={submitOptumPro}
                    />
                      ),
                      "waystar": (
<WaystarInputForm
                      canSubmit={canSubmitWaystar}
                      inputFileName={waystarInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      loginFileName={waystarLoginFile?.name ?? ""}
                      onInputFileChange={setWaystarInputFile}
                      onLoginFileChange={setWaystarLoginFile}
                      onSubmit={submitWaystar}
                    />
                      ),
                      "blue-shield": (
<BlueShieldInputForm
                      canSubmit={canSubmitBlueShield}
                      credentialFileName={blueShieldCredentialFile?.name ?? ""}
                      inputFileName={blueShieldInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setBlueShieldCredentialFile}
                      onInputFileChange={setBlueShieldInputFile}
                      onSubmit={submitBlueShield}
                    />
                      ),
                      }}
                    />
                  )}
                </div>
              </div>

              <PortalResultRenderer
                portalId={effectivePortalId}
                results={{
                  "iehp": (
<div className="mt-5">
                  <IehpResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
                  ),
                  "aerial": (
<div className="mt-5">
                  <AerialResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
                  ),
                  "regal": (
<div className="mt-5">
                  <RegalResultView
                    canDownloadOutput={Boolean(latestRegalOutput)}
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    mfaRequest={regalMfaRequest}
                    mfaValue={regalMfaValue}
                    onMfaChange={setRegalMfaValue}
                    onMfaSubmit={submitRegalMfaMethod}
                    onOutputDownload={downloadLatestRegalOutput}
                    onOtpChange={setRegalOtpValue}
                    onOtpSubmit={submitRegalOtp}
                    otpRequest={regalOtpRequest}
                    otpValue={regalOtpValue}
                    outputCompleted={latestRegalOutput?.completed}
                    outputTotal={latestRegalOutput?.total}
                    progress={progress}
                    status={status}
                  />
                </div>
                  ),
                  "availity": (
<div className="mt-5">
                  <AvailityResultView
                    canDownloadOutput={canDownloadAvailityOutput}
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    onOutputDownload={downloadLatestAvailityOutput}
                    onOtpChange={setAvailityOtpValue}
                    onOtpSubmit={submitAvailityOtp}
                    outputCompleted={latestAvailityOutput?.completed}
                    outputTotal={latestAvailityOutput?.total}
                    otpRequest={availityOtpRequest}
                    otpValue={availityOtpValue}
                    progress={progress}
                    status={status}
                  />
                </div>
                  ),
                  "waystar": (
<div className="mt-5">
                  <WaystarResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
                  ),
                  "uhc": (
<div className="mt-5">
                  <UhcResultView
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    onOtpChange={setUhcOtpValue}
                    onOtpSubmit={submitUhcOtp}
                    onProviderChange={(value) => setUhcProviderPrompt((current) => current ? { ...current, value } : current)}
                    onProviderSubmit={submitUhcProviderSelection}
                    otpRequest={uhcOtpRequest}
                    otpValue={uhcOtpValue}
                    progress={progress}
                    providerPrompt={uhcProviderPrompt}
                    status={status}
                  />
                </div>
                  ),
                  "astrona": (
<div className="mt-5">
                  <AstronaResultView errorScreenshots={errorScreenshots} isProcessing={isProcessing} logs={logs} progress={progress} rows={astronaResults} status={status} />
                </div>
                  ),
                  "all-care": (
<div className="mt-5">
                  <AllCareResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
                  ),
                  "cigna": (
<div className="mt-5">
                  <CignaResultView
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    onOtpChange={setCignaOtpValue}
                    onOtpSubmit={submitCignaOtp}
                    otpRequest={cignaOtpRequest}
                    otpValue={cignaOtpValue}
                    progress={progress}
                    status={status}
                  />
                </div>
                  ),
                  "kaiser": (
<div className="mt-5">
                  <KaiserResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
                  ),
                  "my-family": (
<div className="mt-5">
                  <MyFamilyResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
                  ),
                  "physicians": (
<div className="mt-5">
                  <PhysiciansResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
                  ),
                  "optum-pro": (
<div className="mt-5">
                  <OptumProResultView
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    canStop={Boolean(optumProJobId && (isProcessing || optumProStaleRunAvailable))}
                    isStopping={optumProStopping}
                    onOtpChange={setOptumProOtpValue}
                    onOtpSubmit={submitOptumProOtp}
                    onStop={stopOptumPro}
                    otpRequest={optumProOtpRequest}
                    otpValue={optumProOtpValue}
                    progress={progress}
                    status={status}
                  />
                </div>
                  ),
                  "blue-shield": (
<div className="mt-5">
                  <BlueShieldResultView
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    onOtpChange={setBlueShieldOtpValue}
                    onOtpSubmit={submitBlueShieldOtp}
                    otpRequest={blueShieldOtpRequest}
                    otpValue={blueShieldOtpValue}
                    progress={progress}
                    status={status}
                  />
                </div>
                  ),
                }}
              />
            </>
            )}
          </div>
        )}
          </div>
        </div>
      </div>
    </main>
  );
}
