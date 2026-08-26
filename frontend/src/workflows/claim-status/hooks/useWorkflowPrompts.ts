import { useState } from "react";
import type { ScrapeJobEvent } from "../../../types/job";

export type OtpRequest = {
  inputName: string;
  label: string;
  message: string;
};

export function useWorkflowPrompts() {
  const [availityOtpRequest, setAvailityOtpRequest] = useState<OtpRequest | null>(null);
  const [availityOtpValue, setAvailityOtpValue] = useState("");
  const [cignaOtpRequest, setCignaOtpRequest] = useState<OtpRequest | null>(null);
  const [cignaOtpValue, setCignaOtpValue] = useState("");
  const [optumProOtpRequest, setOptumProOtpRequest] = useState<OtpRequest | null>(null);
  const [optumProOtpValue, setOptumProOtpValue] = useState("");
  const [blueShieldOtpRequest, setBlueShieldOtpRequest] = useState<OtpRequest | null>(null);
  const [blueShieldOtpValue, setBlueShieldOtpValue] = useState("");
  const [regalMfaRequest, setRegalMfaRequest] = useState<{
    inputName: string;
    label: string;
    message: string;
    options: NonNullable<ScrapeJobEvent["options"]>;
  } | null>(null);
  const [regalMfaValue, setRegalMfaValue] = useState("");
  const [regalOtpRequest, setRegalOtpRequest] = useState<OtpRequest | null>(null);
  const [regalOtpValue, setRegalOtpValue] = useState("");

  return {
    availityOtpRequest, availityOtpValue, blueShieldOtpRequest, blueShieldOtpValue,
    cignaOtpRequest, cignaOtpValue, optumProOtpRequest, optumProOtpValue,
    regalMfaRequest, regalMfaValue, regalOtpRequest, regalOtpValue,
    setAvailityOtpRequest, setAvailityOtpValue, setBlueShieldOtpRequest,
    setBlueShieldOtpValue, setCignaOtpRequest, setCignaOtpValue,
    setOptumProOtpRequest, setOptumProOtpValue, setRegalMfaRequest,
    setRegalMfaValue, setRegalOtpRequest, setRegalOtpValue,
  };
}
