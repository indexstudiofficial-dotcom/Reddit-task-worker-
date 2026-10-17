// ============================================================
// REPORTLI AI — REDDIT TASK WORKER
// Version: 2.2.0
//
// Changes in 2.2.0 (fix for intermittent SARVAM_EMPTY_CONTENT):
// - sarvam-105b is a reasoning model. With max_tokens 1500 the
//   "thinking" could use the whole budget, leaving message.content
//   empty/null (finish_reason: "length"). Fixed by:
//     * raising max_tokens to 6000
//     * reasoning_effort: "low"
//     * removing response_format (can yield empty content)
//     * stripping <think> blocks and extracting the JSON object
//     * retrying up to 3 times on empty/invalid/wrong-count output
//     * logging finish_reason when content is empty
// ============================================================

const WORKER_TYPE = "reddit_research";
const SOURCE = "reddit";
const TASK_COUNT = 5;
const SARVAM_MAX_ATTEMPTS = 3;

// ============================================================
// REQUEST HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        worker: "reddit-task-worker",
        version: "2.2.0",
      });
    }

    if (
      request.method !== "POST" ||
      (url.pathname !== "/" && url.pathname !== "/cron")
    ) {
      return jsonResponse(
        { error: "Use POST /cron to trigger the worker." },
        405
      );
    }

    try {
      validateEnvironment(env);

      const result = await runCron(env);

      return jsonResponse({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error("Reddit Task Worker failed:", {
        code: error.code || "WORKER_ERROR",
        message: error.message,
      });

      return jsonResponse(
        {
          ok: false,
          error: error.code || "WORKER_ERROR",
          message: error.message,
        },
        500
      );
    }
  },
};

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment(env) {
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY",
  ]) {
    if (!env[name]) {
      throw createError(
        "CONFIG_MISSING",
        `Missing Cloudflare secret: ${name}`
      );
    }
  }
}

// ============================================================
// ERROR HELPER
// ============================================================

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ============================================================
// SUPABASE REST API HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  let response;

  try {
    response = await fetch(`${baseUrl}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (error) {
    throw createError(
      "SUPABASE_NETWORK_ERROR",
      `Could not connect to Supabase: ${error.message}`
    );
  }

  const bodyText = await response.text();

  if (!response.ok) {
    console.error("Supabase HTTP error:", {
      status: response.status,
      path,
      body: bodyText.slice(0, 2000),
    });

    throw createError(
      `SUPABASE_HTTP_${response.status}`,
      `Supabase returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`
    );
  }

  if (!bodyText.trim()) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

// ============================================================
// GET APPLICATIONS
// ============================================================

async function getApplications(env) {
  const rows = await supabaseRequest(
    env,
    "applications?select=id,user_id,company&order=created_at.asc&limit=1000"
  );

  if (!Array.isArray(rows)) {
    throw createError(
      "APPLICATIONS_INVALID_RESPONSE",
      "Supabase did not return an applications array."
    );
  }

  return rows;
}

// ============================================================
// GET LATEST REDDIT TASK
// ============================================================

async function getLatestRedditTask(env, applicationId) {
  const query = new URLSearchParams({
    select: "id,status",
    application_id: `eq.${applicationId}`,
    source: `eq.${SOURCE}`,
    order: "created_at.desc,id.desc",
    limit: "1",
  });

  const rows = await supabaseRequest(
    env,
    `planner_runs?${query.toString()}`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ============================================================
// GET CUSTOMER NICHES
// ============================================================

async function getCustomerNiches(env, applicationId) {
  const query = new URLSearchParams({
    select:
      "id,application_id,user_id,niche_name,buying_intention,reddit_status,created_at,updated_at",
    application_id: `eq.${applicationId}`,
    order: "created_at.asc",
    limit: "1000",
  });

  const rows = await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`
  );

  if (!Array.isArray(rows)) {
    throw createError(
      "NICHES_INVALID_RESPONSE",
      "Supabase did not return a customer_niches array."
    );
  }

  return rows;
}

// ============================================================
// SELECT A NICHE
// ============================================================

function selectNiche(niches) {
  if (!niches.length) {
    return { niche: null, rotation: false };
  }

  const pending = niches.filter(
    (niche) =>
      String(niche.reddit_status || "").toLowerCase() === "pending"
  );

  if (pending.length) {
    pending.sort((a, b) => {
      const score =
        Number(b.buying_intention || 0) -
        Number(a.buying_intention || 0);

      if (score !== 0) return score;

      return (
        new Date(a.created_at || 0).getTime() -
        new Date(b.created_at || 0).getTime()
      );
    });

    return { niche: pending[0], rotation: false };
  }

  const allCompleted = niches.every(
    (niche) =>
      String(niche.reddit_status || "").toLowerCase() === "completed"
  );

  if (!allCompleted) {
    return { niche: null, rotation: false };
  }

  const oldestFirst = [...niches].sort((a, b) => {
    const aTime = a.updated_at
      ? new Date(a.updated_at).getTime()
      : 0;

    const bTime = b.updated_at
      ? new Date(b.updated_at).getTime()
      : 0;

    if (aTime !== bTime) return aTime - bTime;

    return (
      new Date(a.created_at || 0).getTime() -
      new Date(b.created_at || 0).getTime()
    );
  });

  return { niche: oldestFirst[0], rotation: true };
}

// ============================================================
// SARVAM AI — ONE CALL
//
// Returns { status, content, reasoning, finishReason }.
// Throws only for network / HTTP / non-JSON-envelope problems.
// Empty content is returned (not thrown) so the caller can retry.
// ============================================================

async function callSarvam(env, prompt, useOptionalParams) {
  const body = {
    model: "sarvam-105b",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    // Reasoning models spend tokens on "thinking" BEFORE the answer.
    // 1500 was too small, so content was sometimes empty.
    max_tokens: 6000,
  };

  if (useOptionalParams) {
    body.reasoning_effort = "low";
  }

  let response;

  try {
    response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": env.SARVAM_API_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw createError(
      "SARVAM_NETWORK_ERROR",
      `Could not connect to Sarvam: ${error.message}`
    );
  }

  const responseText = await response.text();

  console.log("Sarvam HTTP status:", response.status);

  if (!response.ok) {
    console.error("Sarvam error body:", responseText.slice(0, 2000));

    const err = createError(
      `SARVAM_HTTP_${response.status}`,
      `Sarvam returned HTTP ${response.status}.`
    );
    err.status = response.status;
    throw err;
  }

  if (!responseText.trim()) {
    return { content: "", reasoning: "", finishReason: "empty_body" };
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    console.error("Sarvam invalid JSON:", responseText.slice(0, 2000));
    throw createError(
      "SARVAM_INVALID_JSON",
      "Sarvam returned invalid JSON."
    );
  }

  const choice = data?.choices?.[0];
  let content = choice?.message?.content;

  if (Array.isArray(content)) {
    content = content.map((part) => part?.text || "").join("");
  }

  if (content && typeof content === "object") {
    content = JSON.stringify(content);
  }

  return {
    content: typeof content === "string" ? content : "",
    reasoning:
      typeof choice?.message?.reasoning_content === "string"
        ? choice.message.reasoning_content
        : "",
    finishReason: choice?.finish_reason || "unknown",
  };
}

// ============================================================
// EXTRACT A JSON OBJECT FROM MODEL TEXT
//
// Handles <think> blocks, ```json fences and extra prose.
// ============================================================

function extractJsonObject(text) {
  if (typeof text !== "string") return null;

  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();

  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to brace extraction
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ============================================================
// SARVAM AI
// Generate 5 subreddit names and 5 search queries (with retries).
// ============================================================

async function generateResearchPlan(env, company, nicheName) {
  const prompt = `
You are a Reddit market research planner.

COMPANY CONTEXT:
${String(company || "No company description provided").slice(0, 12000)}

CUSTOMER NICHE:
${nicheName}

Return ONLY a valid JSON object in this format:

{
  "subreddits": [
    "subreddit1",
    "subreddit2",
    "subreddit3",
    "subreddit4",
    "subreddit5"
  ],
  "queries": [
    "search query 1",
    "search query 2",
    "search query 3",
    "search query 4",
    "search query 5"
  ]
}

Rules:
- Exactly 5 unique subreddit names.
- Exactly 5 unique search queries.
- Do not include r/ before subreddit names.
- Do not include URLs or explanations.
- Select relevant subreddits for this niche.
- Search for business problems, challenges, frustrations,
  and solutions people are seeking.
- Avoid inventing subreddit names.
- Output only the JSON object, with no text before or after it.
`;

  let useOptionalParams = true;
  let lastError = null;

  for (let attempt = 1; attempt <= SARVAM_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await callSarvam(env, prompt, useOptionalParams);

      // Prefer the real answer. Only if it is empty, try to salvage
      // a JSON object from the reasoning text.
      let plan = extractJsonObject(result.content);

      if (!plan && !result.content.trim() && result.reasoning) {
        plan = extractJsonObject(result.reasoning);
      }

      if (!result.content.trim() && !plan) {
        console.error("Sarvam returned empty content:", {
          attempt,
          finish_reason: result.finishReason,
          reasoning_chars: result.reasoning.length,
        });

        lastError = createError(
          "SARVAM_EMPTY_CONTENT",
          `Sarvam returned an empty response (finish_reason: ${result.finishReason}).`
        );
        continue;
      }

      if (!plan) {
        lastError = createError(
          "SARVAM_INVALID_PLAN_JSON",
          "Sarvam's response did not contain valid plan JSON."
        );
        continue;
      }

      const subreddits = normalizeUniqueStrings(plan.subreddits);
      const queries = normalizeUniqueStrings(plan.queries);

      if (subreddits.length !== 5 || queries.length !== 5) {
        lastError = createError(
          "SARVAM_INVALID_PLAN_COUNT",
          `Expected 5 subreddits and 5 queries; received ${subreddits.length} subreddits and ${queries.length} queries.`
        );
        continue;
      }

      return { subreddits, queries };
    } catch (error) {
      lastError = error;

      // If Sarvam rejects the optional parameter, retry without it.
      if (error.status === 400 && useOptionalParams) {
        useOptionalParams = false;
        continue;
      }

      // Retry only transient errors.
      const transient =
        error.code === "SARVAM_NETWORK_ERROR" ||
        error.code === "SARVAM_HTTP_429" ||
        (error.status && error.status >= 500);

      if (!transient) throw error;
    }

    console.warn(`Sarvam attempt ${attempt} failed; retrying.`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }

  throw (
    lastError ||
    createError("SARVAM_EMPTY_CONTENT", "Sarvam failed after retries.")
  );
}

// ============================================================
// CLEAN AND DEDUPLICATE AI RESULTS
// ============================================================

function normalizeUniqueStrings(values) {
  if (!Array.isArray(values)) return [];

  const result = [];
  const seen = new Set();

  for (const value of values) {
    if (typeof value !== "string") continue;

    let cleaned = value
      .trim()
      .replace(/^[-*]\s*/, "")
      .replace(/^r\//i, "")
      .replace(/^["']|["']$/g, "")
      .trim();

    if (!cleaned) continue;

    const key = cleaned.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(cleaned);
  }

  return result;
}

// ============================================================
// FORMAT TASK AS PLAIN TEXT
// ============================================================

function formatTask(nicheName, plan) {
  return [
    `Customer Niche: ${nicheName}`,
    "",
    `Objective: Find 5 relevant Reddit posts from ${nicheName} discussing business problems, challenges, and solutions they are looking for.`,
    "",
    "Recommended Subreddits:",
    ...plan.subreddits.map((name) => `- r/${name}`),
    "",
    "Search Queries:",
    ...plan.queries.map((query) => `- ${query}`),
  ].join("\n");
}

// ============================================================
// INSERT PLANNER TASK
// ============================================================

async function insertPlannerTask(env, row) {
  return await supabaseRequest(env, "planner_runs", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
}

// ============================================================
// NICHE STATUS UPDATE (verified)
// ============================================================

async function updateNiche(env, nicheId, status, updatedAt) {
  const query = new URLSearchParams({
    id: `eq.${nicheId}`,
    select: "id,application_id,niche_name,reddit_status,updated_at",
  });

  const rows = await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        reddit_status: status,
        updated_at: updatedAt,
      }),
    }
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    throw createError(
      "NICHE_STATUS_UPDATE_FAILED",
      `Supabase updated zero rows for niche ID ${nicheId}. Verify that the UUID exists and the service-role key has permission.`
    );
  }

  const saved = rows[0];

  if (
    String(saved.reddit_status || "").toLowerCase() !==
    String(status).toLowerCase()
  ) {
    throw createError(
      "NICHE_STATUS_VERIFICATION_FAILED",
      `Niche ${nicheId} has status "${saved.reddit_status}", expected "${status}".`
    );
  }

  console.log(
    JSON.stringify({
      event: "niche_status_updated",
      niche_id: saved.id,
      application_id: saved.application_id,
      niche_name: saved.niche_name,
      reddit_status: saved.reddit_status,
      updated_at: saved.updated_at,
    })
  );

  return saved;
}

// ============================================================
// SAVE ERROR TO planner_runs.error
// ============================================================

async function saveFailedTask(env, application, niche, error) {
  const errorCode = error.code || "REDDIT_TASK_ERROR";

  const row = {
    application_id: application.id,
    user_id: application.user_id || niche?.user_id || null,
    worker_type: WORKER_TYPE,
    source: SOURCE,
    task: niche
      ? `Reddit research task generation failed for customer niche: ${niche.niche_name}`
      : "Reddit research task failed because no niche was selected.",
    pending_count: TASK_COUNT,
    error: errorCode,
    niche: niche?.niche_name || null,
    created_at: new Date().toISOString(),
    started_at: null,
    status: "failed",
  };

  try {
    await insertPlannerTask(env, row);

    console.log(
      JSON.stringify({
        event: "failed_task_saved",
        application_id: application.id,
        niche: niche?.niche_name || null,
        error: errorCode,
      })
    );
  } catch (saveError) {
    console.error("Could not save failed task:", {
      application_id: application.id,
      original_error: errorCode,
      save_error: saveError.code || saveError.message,
    });
  }
}

// ============================================================
// PROCESS ONE APPLICATION
// ============================================================

async function processApplication(env, application) {
  let selectedNiche = null;

  try {
    const latestTask = await getLatestRedditTask(env, application.id);

    const latestStatus = String(latestTask?.status || "").toLowerCase();

    if (latestStatus === "pending") {
      return {
        application_id: application.id,
        created: false,
        reason: "reddit_task_already_pending",
      };
    }

    if (
      latestTask &&
      latestStatus !== "completed" &&
      latestStatus !== "failed"
    ) {
      return {
        application_id: application.id,
        created: false,
        reason: "latest_task_status_not_eligible",
        status: latestTask.status,
      };
    }

    const niches = await getCustomerNiches(env, application.id);
    const selection = selectNiche(niches);

    selectedNiche = selection.niche;

    if (!selectedNiche) {
      return {
        application_id: application.id,
        created: false,
        reason: "no_pending_niche",
      };
    }

    const plan = await generateResearchPlan(
      env,
      application.company,
      selectedNiche.niche_name
    );

    const taskText = formatTask(selectedNiche.niche_name, plan);
    const now = new Date().toISOString();

    const createdRows = await insertPlannerTask(env, {
      application_id: application.id,
      user_id: application.user_id || selectedNiche.user_id || null,
      worker_type: WORKER_TYPE,
      source: SOURCE,
      task: taskText,
      pending_count: TASK_COUNT,
      error: null,
      niche: selectedNiche.niche_name,
      created_at: now,
      started_at: null,
      status: "pending",
    });

    if (!Array.isArray(createdRows) || createdRows.length === 0) {
      throw createError(
        "PLANNER_TASK_INSERT_FAILED",
        "Supabase did not confirm creation of the planner task."
      );
    }

    await updateNiche(env, selectedNiche.id, "Completed", now);

    if (selection.rotation) {
      const otherNiches = niches.filter(
        (niche) => niche.id !== selectedNiche.id
      );

      for (const niche of otherNiches) {
        await updateNiche(env, niche.id, "pending", now);
      }

      console.log(
        JSON.stringify({
          event: "niche_rotation_completed",
          application_id: application.id,
          processed_niche: selectedNiche.niche_name,
          reset_niches_to_pending: otherNiches.length,
        })
      );
    }

    return {
      application_id: application.id,
      created: true,
      niche: selectedNiche.niche_name,
      planner_run_id: createdRows[0].id,
      rotation: selection.rotation,
      niche_status_updated: true,
    };
  } catch (error) {
    console.error("Application processing failed:", {
      application_id: application.id,
      niche: selectedNiche?.niche_name || null,
      code: error.code || "REDDIT_TASK_ERROR",
      message: error.message,
    });

    await saveFailedTask(env, application, selectedNiche, error);

    return {
      application_id: application.id,
      created: false,
      status: "failed",
      niche: selectedNiche?.niche_name || null,
      error: error.code || "REDDIT_TASK_ERROR",
      message: error.message,
    };
  }
}

// ============================================================
// RUN CRON
// ============================================================

async function runCron(env) {
  const applications = await getApplications(env);

  const result = {
    applications_checked: applications.length,
    tasks_created: 0,
    applications_skipped: 0,
    failed: 0,
    details: [],
  };

  for (const application of applications) {
    const outcome = await processApplication(env, application);

    result.details.push(outcome);

    if (outcome.created) {
      result.tasks_created++;
    } else if (outcome.status === "failed") {
      result.failed++;
    } else {
      result.applications_skipped++;
    }

    console.log(JSON.stringify(outcome));
  }

  return result;
}

// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
