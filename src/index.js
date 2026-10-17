// ============================================================
// Reportli AI — Reddit Task Worker
// Version: 2.0.0
//
// Features:
// 1. Triggered by Supabase Cron using POST /cron.
// 2. Reads applications and customer_niches.
// 3. Selects the highest buying-intention pending niche.
// 4. If all niches are Completed, rotates using oldest updated_at.
// 5. Uses Sarvam AI to generate 5 subreddits and 5 queries.
// 6. Saves failures to planner_runs.error.
// 7. Allows failed tasks to be retried on a later Cron run.
// ============================================================

const WORKER_TYPE = "reddit_research";
const SOURCE = "reddit";
const TASK_COUNT = 5;

// ============================================================
// MAIN REQUEST HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        worker: "reddit-task-worker",
        version: "2.0.0",
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

      const results = await runCron(env);

      return jsonResponse({
        ok: true,
        ...results,
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
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY",
  ];

  for (const name of required) {
    if (!env[name]) {
      throw createError(
        "CONFIG_MISSING",
        `Missing Cloudflare secret: ${name}`
      );
    }
  }
}

// ============================================================
// SUPABASE REST API HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const bodyText = await response.text();

  if (!response.ok) {
    console.error("Supabase request failed:", {
      status: response.status,
      path,
      body: bodyText.slice(0, 2000),
    });

    throw createError(
      `SUPABASE_HTTP_${response.status}`,
      `Supabase request failed with HTTP ${response.status}`
    );
  }

  if (!bodyText) {
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
  return await supabaseRequest(
    env,
    "applications?select=id,user_id,company&order=created_at.asc&limit=1000"
  );
}

// ============================================================
// GET LATEST REDDIT TASK FOR AN APPLICATION
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

  return rows?.[0] || null;
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

  return await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`
  );
}

// ============================================================
// NICHE SELECTION
//
// Normal operation:
//   Choose the pending niche with the highest buying_intention.
//
// Rotation:
//   If every niche is Completed, choose the oldest updated_at.
//   After successful task creation, set the other niches pending.
// ============================================================

function selectNiche(niches) {
  if (!Array.isArray(niches) || niches.length === 0) {
    return {
      niche: null,
      rotation: false,
    };
  }

  const pendingNiches = niches.filter(
    (niche) =>
      String(niche.reddit_status || "").toLowerCase() === "pending"
  );

  // Normal queue: highest buying intention first.
  if (pendingNiches.length > 0) {
    pendingNiches.sort((a, b) => {
      const scoreDifference =
        Number(b.buying_intention || 0) -
        Number(a.buying_intention || 0);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return (
        new Date(a.created_at || 0).getTime() -
        new Date(b.created_at || 0).getTime()
      );
    });

    return {
      niche: pendingNiches[0],
      rotation: false,
    };
  }

  // Rotate only when ALL niches are Completed.
  const allCompleted = niches.every(
    (niche) =>
      String(niche.reddit_status || "").toLowerCase() === "completed"
  );

  if (!allCompleted) {
    return {
      niche: null,
      rotation: false,
    };
  }

  // Oldest updated_at first.
  const completedNiches = [...niches].sort((a, b) => {
    const aTime = a.updated_at
      ? new Date(a.updated_at).getTime()
      : 0;

    const bTime = b.updated_at
      ? new Date(b.updated_at).getTime()
      : 0;

    if (aTime !== bTime) {
      return aTime - bTime;
    }

    return (
      new Date(a.created_at || 0).getTime() -
      new Date(b.created_at || 0).getTime()
    );
  });

  return {
    niche: completedNiches[0],
    rotation: true,
  };
}

// ============================================================
// SARVAM AI — GENERATE SUBREDDITS AND SEARCH QUERIES
// ============================================================

async function generateResearchPlan(env, company, nicheName) {
  const prompt = `
You are a Reddit market research planner.

COMPANY CONTEXT:
${String(company || "No company description provided").slice(0, 12000)}

CUSTOMER NICHE:
${nicheName}

Generate a practical Reddit research plan for this customer niche.

Return ONLY a valid JSON object with this exact structure:

{
  "subreddits": [
    "subreddit_name_1",
    "subreddit_name_2",
    "subreddit_name_3",
    "subreddit_name_4",
    "subreddit_name_5"
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
- Return exactly 5 unique subreddit names.
- Return exactly 5 unique search queries.
- Subreddit names must not contain the r/ prefix.
- Do not include URLs.
- Do not include explanations outside the JSON.
- Choose relevant subreddits for the niche and company context.
- Queries should find Reddit discussions about business problems,
  challenges, frustrations, and solutions people are seeking.
- Do not invent subreddit names if you can avoid it.
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
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.2,
          max_tokens: 1500,
          response_format: {
            type: "json_object",
          },
        }),
      }
    );
  } catch (error) {
    throw createError(
      "SARVAM_NETWORK_ERROR",
      `Could not connect to Sarvam: ${error.message}`
    );
  }

  // Read the response body exactly once.
  const responseText = await response.text();

  console.log("Sarvam HTTP status:", response.status);

  if (!response.ok) {
    console.error("Sarvam error response:", responseText.slice(0, 2000));

    throw createError(
      `SARVAM_HTTP_${response.status}`,
      `Sarvam returned HTTP ${response.status}`
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
      "Sarvam returned invalid JSON:",
      responseText.slice(0, 2000)
    );

    throw createError(
      "SARVAM_INVALID_JSON",
      "Sarvam returned a response that was not valid JSON."
    );
  }

  let content = data?.choices?.[0]?.message?.content;

  if (Array.isArray(content)) {
    content = content
      .map((part) => part?.text || "")
      .join("");
  }

  if (content && typeof content === "object") {
    content = JSON.stringify(content);
  }

  if (typeof content !== "string" || !content.trim()) {
    console.error(
      "Sarvam response had no usable message content:",
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
    console.error("Sarvam content was not valid plan JSON:", content);

    throw createError(
      "SARVAM_INVALID_PLAN_JSON",
      "Sarvam's message did not contain valid plan JSON."
    );
  }

  const subreddits = normalizeUniqueStrings(plan.subreddits);
  const queries = normalizeUniqueStrings(plan.queries);

  if (subreddits.length !== 5 || queries.length !== 5) {
    throw createError(
      "SARVAM_INVALID_PLAN_COUNT",
      `Expected 5 unique subreddits and 5 queries; received ${subreddits.length} subreddits and ${queries.length} queries.`
    );
  }

  return {
    subreddits,
    queries,
  };
}

// ============================================================
// NORMALIZE AND VALIDATE SARVAM ARRAYS
// ============================================================

function normalizeUniqueStrings(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const unique = [];
  const seen = new Set();

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    let cleaned = value.trim();

    if (!cleaned) {
      continue;
    }

    cleaned = cleaned
      .replace(/^[-*]\s*/, "")
      .replace(/^r\//i, "")
      .replace(/^["']|["']$/g, "")
      .trim();

    const key = cleaned.toLowerCase();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(cleaned);
  }

  return unique;
}

// ============================================================
// FORMAT THE TASK AS PLAIN TEXT
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
// CREATE A PLANNER TASK ROW
// ============================================================

async function insertPlannerTask(env, taskRow) {
  return await supabaseRequest(
    env,
    "planner_runs",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(taskRow),
    }
  );
}

// ============================================================
// SAVE A FAILURE TO planner_runs.error
//
// A failed task is recorded even if Sarvam fails before generating
// the actual task text.
// ============================================================

async function saveFailedTask(
  env,
  application,
  niche,
  error
) {
  const errorCode = error.code || "REDDIT_TASK_ERROR";

  const row = {
    application_id: application.id,
    user_id: application.user_id || niche?.user_id || null,
    worker_type: WORKER_TYPE,
    source: SOURCE,
    task: niche
      ? `Reddit research task generation failed for customer niche: ${niche.niche_name}`
      : "Reddit research task generation failed because no customer niche was selected.",
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
        application_id: application.id,
        created: false,
        status: "failed",
        error: errorCode,
        niche: niche?.niche_name || null,
      })
    );
  } catch (saveError) {
    console.error("Could not save failure to planner_runs:", {
      application_id: application.id,
      original_error: errorCode,
      save_error: saveError.code || saveError.message,
    });
  }
}

// ============================================================
// UPDATE A NICHE STATUS
// ============================================================

async function updateNiche(env, nicheId, status, updatedAt) {
  const query = new URLSearchParams({
    id: `eq.${nicheId}`,
  });

  return await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        reddit_status: status,
        updated_at: updatedAt,
      }),
    }
  );
}

// ============================================================
// PROCESS ONE APPLICATION
// ============================================================

async function processApplication(env, application) {
  let selectedNiche = null;

  try {
    // --------------------------------------------------------
    // 1. Check the most recent Reddit task.
    // --------------------------------------------------------

    const latestTask = await getLatestRedditTask(
      env,
      application.id
    );

    const latestStatus = String(
      latestTask?.status || ""
    ).toLowerCase();

    if (latestStatus === "pending") {
      return {
        application_id: application.id,
        created: false,
        reason: "reddit_task_already_pending",
      };
    }

    // Completed tasks allow a new task.
    // Failed tasks also allow a retry.
    //
    // Other statuses are skipped to avoid duplicate work.
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

    // --------------------------------------------------------
    // 2. Load niches and select one.
    // --------------------------------------------------------

    const niches = await getCustomerNiches(
      env,
      application.id
    );

    const selection = selectNiche(niches);

    selectedNiche = selection.niche;

    if (!selectedNiche) {
      return {
        application_id: application.id,
        created: false,
        reason: "no_pending_niche",
      };
    }

    // --------------------------------------------------------
    // 3. Ask Sarvam to generate the research plan.
    //
    // If this fails, save the error code in planner_runs.error.
    // --------------------------------------------------------

    const plan = await generateResearchPlan(
      env,
      application.company,
      selectedNiche.niche_name
    );

    const taskText = formatTask(
      selectedNiche.niche_name,
      plan
    );

    // --------------------------------------------------------
    // 4. Insert the task first.
    //
    // Do not reset other niches until task generation succeeds.
    // --------------------------------------------------------

    const now = new Date().toISOString();

    const taskRow = {
      application_id: application.id,
      user_id:
        application.user_id || selectedNiche.user_id || null,
      worker_type: WORKER_TYPE,
      source: SOURCE,
      task: taskText,
      pending_count: TASK_COUNT,
      error: null,
      niche: selectedNiche.niche_name,
      created_at: now,
      started_at: null,
      status: "pending",
    };

    await insertPlannerTask(env, taskRow);

    // --------------------------------------------------------
    // 5. Mark the selected niche Completed.
    //
    // updated_at now records when this niche was processed.
    // --------------------------------------------------------

    await updateNiche(
      env,
      selectedNiche.id,
      "Completed",
      now
    );

    // --------------------------------------------------------
    // 6. If all niches were previously Completed, rotate.
    //
    // The oldest updated_at niche is processed first.
    // After its task is created, the other niches are reset
    // to pending so they can be researched again.
    // --------------------------------------------------------

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
          application_id: application.id,
          rotation: true,
          processed_niche: selectedNiche.niche_name,
          reset_niches_to_pending: otherNiches.length,
        })
      );
    }

    return {
      application_id: application.id,
      created: true,
      niche: selectedNiche.niche_name,
      rotation: selection.rotation,
    };
  } catch (error) {
    console.error("Application processing failed:", {
      application_id: application.id,
      niche: selectedNiche?.niche_name || null,
      code: error.code || "REDDIT_TASK_ERROR",
      message: error.message,
    });

    await saveFailedTask(
      env,
      application,
      selectedNiche,
      error
    );

    return {
      application_id: application.id,
      created: false,
      status: "failed",
      error: error.code || "REDDIT_TASK_ERROR",
    };
  }
}

// ============================================================
// RUN THE CRON JOB
// ============================================================

async function runCron(env) {
  const applications = await getApplications(env);

  if (!Array.isArray(applications)) {
    throw createError(
      "APPLICATIONS_INVALID_RESPONSE",
      "Supabase did not return an applications array."
    );
  }

  const results = {
    applications_checked: applications.length,
    tasks_created: 0,
    applications_skipped: 0,
    failed: 0,
    details: [],
  };

  // Sequential processing helps avoid sending many requests
  // to Sarvam simultaneously.
  for (const application of applications) {
    const result = await processApplication(
      env,
      application
    );

    results.details.push(result);

    if (result.created) {
      results.tasks_created++;
    } else if (result.status === "failed") {
      results.failed++;
    } else {
      results.applications_skipped++;
    }

    console.log(JSON.stringify(result));
  }

  // Return results even if an individual application failed.
  // This prevents one Sarvam failure from hiding the other
  // applications' results from the Cron response.
  return results;
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
// JSON RESPONSE HELPER
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
      }
