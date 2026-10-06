// Keeps a Cloudflare Access policy's email allowlist in step with sharing, so a site admin who
// shares a workspace with a new email also lets that person through the Access front door.
//
// Enabled only when CF_ACCESS_ADMIN_TOKEN (an "Access: Apps and Policies: Edit" API token),
// CF_ACCESS_ACCOUNT_ID and CF_ACCESS_POLICY_ID are all set. CF_ACCESS_ADMIN_IDS lists the
// profile ids (comma-separated) allowed to extend the allowlist; anyone else can only share
// with emails that are already on it.

export interface AccessAllowlistEnv {
  CF_ACCESS_ADMIN_TOKEN?: string;
  CF_ACCESS_ACCOUNT_ID?: string;
  CF_ACCESS_POLICY_ID?: string;
  CF_ACCESS_ADMIN_IDS?: string;
}

type Rule = { email?: { email?: string } } & Record<string, unknown>;

// Writable policy fields to carry over unchanged when replacing the policy.
const WRITABLE_FIELDS = [
  "name", "decision", "include", "exclude", "require", "session_duration",
  "approval_groups", "approval_required", "isolation_required", "mfa_config",
  "purpose_justification_prompt", "purpose_justification_required", "connection_rules",
];

export function accessAllowlistEnabled(env: AccessAllowlistEnv): boolean {
  return !!(env.CF_ACCESS_ADMIN_TOKEN && env.CF_ACCESS_ACCOUNT_ID && env.CF_ACCESS_POLICY_ID);
}

export function isAccessAllowlistAdmin(env: AccessAllowlistEnv, profileId: string): boolean {
  let admins = (env.CF_ACCESS_ADMIN_IDS || "").split(",").map(s => s.trim().toLowerCase())
      .filter(s => s !== "");
  return admins.includes(profileId.trim().toLowerCase());
}

async function policyRequest(env: AccessAllowlistEnv, method: "GET" | "PUT", body?: unknown)
    : Promise<Record<string, unknown>> {
  let url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCESS_ACCOUNT_ID}` +
      `/access/policies/${env.CF_ACCESS_POLICY_ID}`;
  let resp = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${env.CF_ACCESS_ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = await resp.json() as { success?: boolean; result?: Record<string, unknown> };
  if (!resp.ok || !json.success || !json.result) {
    throw new Error(`Couldn't update the sign-in allowlist (Cloudflare HTTP ${resp.status}).`);
  }
  return json.result;
}

function listedEmails(policy: Record<string, unknown>): Set<string> {
  let include = (policy.include as Rule[] | undefined) ?? [];
  return new Set(include.map(r => r.email?.email?.toLowerCase()).filter((e): e is string => !!e));
}

/** True if `email` is already an included email on the policy. */
export async function isEmailAllowlisted(env: AccessAllowlistEnv, email: string)
    : Promise<boolean> {
  return listedEmails(await policyRequest(env, "GET")).has(email.toLowerCase());
}

/** Adds `email` to the policy's include rules if absent. Returns true if it was added. */
export async function addEmailToAllowlist(env: AccessAllowlistEnv, email: string)
    : Promise<boolean> {
  let policy = await policyRequest(env, "GET");
  if (listedEmails(policy).has(email.toLowerCase())) return false;
  let body: Record<string, unknown> = {};
  for (let field of WRITABLE_FIELDS) {
    if (policy[field] !== undefined && policy[field] !== null) body[field] = policy[field];
  }
  body.include = [...((policy.include as Rule[] | undefined) ?? []), { email: { email } }];
  await policyRequest(env, "PUT", body);
  return true;
}
