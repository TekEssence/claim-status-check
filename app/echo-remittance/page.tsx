import { redirect } from "next/navigation";

export default function EchoRemittanceRedirectPage() {
  redirect("/payment-eob-download");
}

