// ============================================================
// REPORTLI AI — REDDIT TASK WORKER
// Version: 2.1.0
//
// Features:
// 1. Triggered by Supabase Cron through POST /cron.
// 2. Selects pending niches by highest buying_intention.
// 3. Generates exactly 5 subreddits and 5 search queries.
// 4. Saves tasks in planner_runs.
// 5. Marks the selected niche Completed and verifies the update.
// 6. If all niches are Completed, processes the oldest updated_at
//    niche and resets the other niches to pending.
// 7. Saves error codes to planner_runs.error.
// 8. Logs Supabase update failures.
// ============================================================

const WORKER_TYPE = "reddit_research";
const SOURCE = "reddit";
const TASK_COUNT = 5;

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
        version: "2.1.0",
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
//
// Normal:
// Highest buying_intention among pending niches.
//
// Rotation:
// If EVERY niche is Completed, choose the oldest updated_at.
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
// SARVAM AI
// Generate 5 subreddit names and 5 search queries.
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
`;

  let response;

  try {
    response = await fetch(
      "https://api.sarvam.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": env.SARVAM_API_KEY,
        },
        body: JSON.stringify({
          model: "sarvam-105b",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 1500,
          response_format: { type: "json_object" },
        }),
      }
    );
  } catch (error) {
    throw createError(
      "SARVAM_NETWORK_ERROR",
      `Could not connect to Sarvam: ${error.message}`
    );
  }

  // Read the response body only once.
  const responseText = await response.text();

  console.log("Sarvam HTTP status:", response.status);

  if (!response.ok) {
    console.error(
      "Sarvam error body:",
      responseText.slice(0, 2000)
    );

    throw createError(
      `SARVAM_HTTP_${response.status}`,
      `Sarvam returned HTTP ${response.status}.`
    );
  }

  if (!responseText.trim()) {
    throw createError(
      "SARVAM_EMPTY_RESPONSE",
      "Sarvam returned an empty HTTP response body."
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    console.error(
      "Sarvam invalid JSON:",
      responseText.slice(0, 2000)
    );

    throw createError(
      "SARVAM_INVALID_JSON",
      "Sarvam returned invalid JSON."
    );
  }

  let content = data?.choices?.[0]?.message?.content;

  if (Array.isArray(content)) {
    content = content.map((part) => part?.text || "").join("");
  }

  if (content && typeof content === "object") {
    content = JSON.stringify(content);
  }

  if (typeof content !== "string" || !content.trim()) {
    console.error(
      "Sarvam returned no usable content:",
      JSON.stringify(data).slice(0, 2000)
    );

    throw createError(
      "SARVAM_EMPTY_CONTENT",
      "Sarvam returned an empty research response."
    );
  }

  let plan;

  try {
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");

    plan = JSON.parse(cleaned);
  } catch {
    throw createError(
      "SARVAM_INVALID_PLAN_JSON",
      "Sarvam's response did not contain valid plan JSON."
    );
  }

  const subreddits = normalizeUniqueStrings(plan.subreddits);
  const queries = normalizeUniqueStrings(plan.queries);

  if (subreddits.length !== 5 || queries.length !== 5) {
    throw createError(
      "SARVAM_INVALID_PLAN_COUNT",
      `Expected 5 subreddits and 5 queries; received ${subreddits.length} subreddits and ${queries.length} queries.`
    );
  }

  return { subreddits, queries };
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
// FIXED NICHE STATUS UPDATE
//
// IMPORTANT:
// - Uses the actual niche UUID.
// - Requests the updated row from Supabase.
// - Verifies that a row was updated.
// - Verifies the saved status.
// - Throws an explicit error if the update did not happen.
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
    // 1. Check the latest Reddit task.
    const latestTask = await getLatestRedditTask(env, application.id);

    const latestStatus = String(
      latestTask?.status || ""
    ).toLowerCase();

    // Don't create another task while one is pending.
    if (latestStatus === "pending") {
      return {
        application_id: application.id,
        created: false,
        reason: "reddit_task_already_pending",
      };
    }

    // Permit a new task after Completed or failed.
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

    // 2. Fetch niches and select the next niche.
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

    // 3. Generate the plan with Sarvam.
    const plan = await generateResearchPlan(
      env,
      application.company,
      selectedNiche.niche_name
    );

    const taskText = formatTask(selectedNiche.niche_name, plan);
    const now = new Date().toISOString();

    // 4. Insert the task.
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

    // 5. Mark the selected niche Completed and VERIFY it.
    // If this fails, an explicit error is logged and saved.
    await updateNiche(
      env,
      selectedNiche.id,
      "Completed",
      now
    );

    // 6. If rotating, reset the other niches to pending.
    // This runs only after the selected niche was successfully
    // marked Completed.
    if (selection.rotation) {
      const otherNiches = niches.filter(
        (niche) => niche.id !== selectedNiche.id
      );

      for (const niche of otherNiches) {
        await updateNiche(
          env,
          niche.id,
          "pending",
          now
        );
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

  // Process sequentially to avoid unnecessary concurrent
  // Sarvam requests.
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

  // Return HTTP 200 for the completed Cron run even when one
  // application failed. Individual failures are in details.
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
