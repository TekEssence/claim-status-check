import type { ReactNode } from "react";
import type { PortalId } from "../shared/model";

export type PortalViewMap = Partial<Record<PortalId, ReactNode>>;

function PortalView({
  portalId,
  views,
  fallback = null,
}: {
  portalId: PortalId | null;
  views: PortalViewMap;
  fallback?: ReactNode;
}) {
  if (!portalId) return fallback;
  return views[portalId] ?? fallback;
}

export function PortalFormRenderer(props: {
  portalId: PortalId | null;
  forms: PortalViewMap;
  fallback?: ReactNode;
}) {
  return <PortalView portalId={props.portalId} views={props.forms} fallback={props.fallback} />;
}

export function PortalResultRenderer(props: {
  portalId: PortalId | null;
  results: PortalViewMap;
  fallback?: ReactNode;
}) {
  return <PortalView portalId={props.portalId} views={props.results} fallback={props.fallback} />;
}
