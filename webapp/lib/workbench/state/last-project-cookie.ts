/*
 * Exports:
 * - LAST_PROJECT_LAUNCH_COOKIE_NAME: path-scoped cookie name copied into an installed iOS web app. Keywords: workbench, project, launch, cookie, iOS.
 * - createLastProjectLaunchCookie/persistLastProjectLaunch: encode and store the confirmed project used by the standalone launch route. Keywords: workbench, project, launch, cookie, persistence.
 * - resolveLastProjectLaunchHref: decode a launch cookie into the canonical project-root route with a safe root fallback. Keywords: workbench, project, launch, route, cookie.
 */

import { createProjectHref } from "../navigation/workbench-route";

export const LAST_PROJECT_LAUNCH_COOKIE_NAME = "workbench-last-project";

const LAST_PROJECT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const MAX_LAST_PROJECT_ID_LENGTH = 2048;

export function createLastProjectLaunchCookie(projectId: string) {
  const normalizedProjectId = projectId.trim().slice(0, MAX_LAST_PROJECT_ID_LENGTH);
  return `${LAST_PROJECT_LAUNCH_COOKIE_NAME}=${encodeURIComponent(normalizedProjectId)}; Path=/launch; Max-Age=${LAST_PROJECT_COOKIE_MAX_AGE_SECONDS}; SameSite=Strict`;
}

export function persistLastProjectLaunch(projectId: string) {
  try {
    document.cookie = createLastProjectLaunchCookie(projectId);
  } catch {
    console.warn("Failed to persist the standalone launch project.");
  }
}

export function resolveLastProjectLaunchHref(cookieValue: string | null | undefined) {
  if (!cookieValue || cookieValue.length > MAX_LAST_PROJECT_ID_LENGTH * 3) {
    return "/";
  }

  try {
    const projectId = decodeURIComponent(cookieValue).trim();
    return projectId && projectId.length <= MAX_LAST_PROJECT_ID_LENGTH
      ? createProjectHref(projectId)
      : "/";
  } catch {
    return "/";
  }
}
