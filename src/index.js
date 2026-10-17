// ============================================================
// REPORTLI AI — REDDIT TASK WORKER
// Version: 1.0.0
//
// Responsibilities:
// 1. Receive a Supabase Cron POST request.
// 2. Check every application.
// 3. Inspect the latest Reddit task in planner_runs.
// 4. Skip applications whose latest Reddit task is pending.
// 5. Create a new task when no Reddit task exists or the
//    latest Reddit task has status Completed.
// 6. Select the highest-buying-intention pending niche.
// 7. Use the applications.company data with Sarvam AI.
// 8. Generate exactly 5 subreddits and 5 search queries.
// 9. Save the task to planner_runs with pending_count = 5.
// 10. Mark the selected niche's reddit_status as Completed.
// ============================================================


// ============================================================
// CONSTANTS
// ============================================================

const WORKER_NAME = "reportli-reddit-task-worker";
const WORKER_VERSION = "1.0.0";

const SARVAM_API_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const REDDIT_WORKER_TYPE = "reddit_research";
const REDDIT_SOURCE = "reddit";

const REQUIRED_QUERY_COUNT = 5;
const REQUIRED_SUBREDDIT_COUNT = 5;


// ============================================================
// MAIN REQUEST HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        success: true,
        worker: WORKER_NAME,
        version: WORKER_VERSION,
        status: "healthy",
        timestamp: new Date().toISOString()
      });
    }

    // Accept Supabase Cron POST requests at / or /cron.
    if (
      request.method === "POST" &&
      (url.pathname === "/" || url.pathname === "/cron")
    ) {
      try {
        validateEnvironment(env);

        const result = await runCron(env);

        return jsonResponse({
          success: true,
          worker: WORKER_NAME,
          ...result
        });
      } catch (error) {
        console.error("Reddit task worker failed:", error.message);

        return jsonResponse(
          {
            success: false,
            worker: WORKER_NAME,
            error: error.message,
            timestamp: new Date().toISOString()
          },
          500
        );
      }
    }

    return jsonResponse(
      {
        success: false,
        error: "Route not found"
      },
      404
    );
  }
};


// ============================================================
// CRON PROCESSOR
// ============================================================

async function runCron(env) {
  const applications = await getApplications(env);

  const results = {
    applications_checked: applications.length,
    tasks_created: 0,
    applications_skipped: 0,
    no_pending_niche: 0,
    errors: []
  };

  for (const application of applications) {
    try {
      const result = await processApplication(application, env);

      if (result.created) {
        results.tasks_created++;
      } else {
        results.applications_skipped++;

        if (result.reason === "no_pending_niche") {
          results.no_pending_niche++;
        }
      }

      console.log(
        JSON.stringify({
          application_id: application.id,
          ...result
        })
      );
    } catch (error) {
      results.errors.push({
        application_id: application.id,
        error: error.message
      });

      console.error(
        `Application ${application.id} failed:`,
        error.message
      );
    }
  }

  // Do not report the entire cron run as successful if one or
  // more applications failed.
  if (results.errors.length > 0) {
    throw new Error(
      JSON.stringify({
        message: "One or more applications failed",
        results
      })
    );
  }

  return results;
}


// ============================================================
// PROCESS ONE APPLICATION
// ============================================================

async function processApplication(application, env) {
  const applicationId = application.id;

  // ----------------------------------------------------------
  // STEP 1: CHECK THE LATEST REDDIT TASK
  // ----------------------------------------------------------

  const latestTask = await getLatestRedditTask(
    applicationId,
    env
  );

  if (latestTask) {
    const status = String(latestTask.status || "")
      .trim()
      .toLowerCase();

    // A pending task already exists.
    // Do not create another one.
    if (status === "pending") {
      return {
        created: false,
        reason: "latest_task_pending",
        latest_task_id: latestTask.id
      };
    }

    // Only a completed task allows the next task to be created.
    if (status !== "completed") {
      return {
        created: false,
        reason: "latest_task_not_completed",
        latest_task_id: latestTask.id,
        latest_task_status: latestTask.status
      };
    }
  }

  // ----------------------------------------------------------
  // STEP 2: SELECT THE HIGHEST-PRIORITY PENDING NICHE
  // ----------------------------------------------------------

  const niche = await getHighestPriorityPendingNiche(
    applicationId,
    env
  );

  if (!niche) {
    return {
      created: false,
      reason: "no_pending_niche"
    };
  }

  // ----------------------------------------------------------
  // STEP 3: GENERATE SEARCH QUERIES AND SUBREDDITS
  // ----------------------------------------------------------

  const research = await generateRedditResearch(
    application.company,
    niche.niche_name,
    env
  );

  // ----------------------------------------------------------
  // STEP 4: BUILD THE REQUIRED TASK TEXT
  // ----------------------------------------------------------

  const objective =
    `Find 5 relevant Reddit posts from ${niche.niche_name} ` +
    "discussing business problems, challenges, and solutions " +
    "they are looking for.";

  const taskText = [
    `Customer Niche: ${niche.niche_name}`,
    "",
    `Objective: ${objective}`,
    "",
    "Recommended Subreddits:",
    ...research.subreddits.map(name => `- r/${name}`),
    "",
    "Search Queries:",
    ...research.queries.map(query => `- ${query}`)
  ].join("\n");

  // ----------------------------------------------------------
  // STEP 5: MARK THE NICHE COMPLETED
  //
  // Update only after successful AI generation.
  // If task insertion fails, restore the niche to pending.
  // ----------------------------------------------------------

  await updateNicheStatus(
    niche.id,
    "Completed",
    env
  );

  let createdTask;

  try {
    // --------------------------------------------------------
    // STEP 6: CREATE THE REDDIT TASK
    // --------------------------------------------------------

    createdTask = await createRedditTask(
      application,
      niche,
      taskText,
      env
    );
  } catch (error) {
    // Restore the niche so a later cron can retry it.
    try {
      await updateNicheStatus(
        niche.id,
        "pending",
        env
      );
    } catch (rollbackError) {
      console.error(
        "Failed to restore niche status:",
        rollbackError.message
      );
    }

    throw error;
  }

  return {
    created: true,
    reason: "reddit_task_created",
    task_id: createdTask.id,
    application_id: applicationId,
    niche_id: niche.id,
    niche_name: niche.niche_name,
    pending_count: createdTask.pending_count,
    subreddit_count: research.subreddits.length,
    query_count: research.queries.length
  };
}


// ============================================================
// GET APPLICATIONS
// ============================================================

async function getApplications(env) {
  return await supabaseRequest(
    "/rest/v1/applications" +
      "?select=id,user_id,company,created_at" +
      "&order=created_at.asc" +
      "&limit=1000",
    env
  );
}


// ============================================================
// GET THE LATEST REDDIT TASK FOR AN APPLICATION
// ============================================================

async function getLatestRedditTask(applicationId, env) {
  const query = new URLSearchParams({
    select: "id,application_id,status,created_at,niche",
    application_id: `eq.${applicationId}`,
    source: `eq.${REDDIT_SOURCE}`,
    order: "created_at.desc,id.desc",
    limit: "1"
  });

  const rows = await supabaseRequest(
    `/rest/v1/planner_runs?${query.toString()}`,
    env
  );

  return rows.length > 0 ? rows[0] : null;
}


// ============================================================
// SELECT HIGHEST BUYING-INTENTION PENDING NICHE
// ============================================================

async function getHighestPriorityPendingNiche(
  applicationId,
  env
) {
  const query = new URLSearchParams({
    select:
      "id,application_id,niche_name,buying_intention," +
      "reddit_status,user_id,created_at",
    application_id: `eq.${applicationId}`,
    reddit_status: "eq.pending",
    order: "created_at.asc",
    limit: "1000"
  });

  const niches = await supabaseRequest(
    `/rest/v1/customer_niches?${query.toString()}`,
    env
  );

  if (!niches.length) {
    return null;
  }

  // Highest buying_intention first.
  // If tied, use the earliest-created niche.
  niches.sort((a, b) => {
    const scoreA =
      a.buying_intention == null
        ? -Infinity
        : Number(a.buying_intention);

    const scoreB =
      b.buying_intention == null
        ? -Infinity
        : Number(b.buying_intention);

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    return (
      new Date(a.created_at).getTime() -
      new Date(b.created_at).getTime()
    );
  });

  return niches[0];
}


// ============================================================
// GENERATE 5 SUBREDDITS AND 5 SEARCH QUERIES WITH SARVAM AI
// ============================================================

async function generateRedditResearch(
  companyData,
  nicheName,
  env
) {
  const companyText =
    companyData == null
      ? "No company information was provided."
      : typeof companyData === "string"
        ? companyData
        : JSON.stringify(companyData);

  const prompt = `
You are generating search instructions for a Reddit research worker.

CUSTOMER NICHE:
${nicheName}

COMPANY DATA:
${companyText}

Your task is to generate exactly:
1. Five relevant subreddit names.
2. Five relevant Reddit search queries.

Requirements for subreddits:
- Suggest communities relevant to the customer niche and company.
- Return subreddit names without the "r/" prefix.
- Do not include URLs.
- Avoid duplicate names.
- Do not invent subreddit names intentionally.
- Prefer established, topic-relevant communities.

Requirements for search queries:
- Return exactly five distinct search queries.
- Focus on business problems, challenges, solution requests,
  and tools relevant to the customer niche.
- Use practical search phrases that can be sent to Reddit search.
- Do not include explanations.

Return ONLY valid JSON in this format:

{
  "subreddits": [
    "example1",
    "example2",
    "example3",
    "example4",
    "example5"
  ],
  "queries": [
    "search query 1",
    "search query 2",
    "search query 3",
    "search query 4",
    "search query 5"
  ]
}
`;

  const response = await fetch(SARVAM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": env.SARVAM_API_KEY
    },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON. Do not add markdown or explanations."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 1500
    })
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Sarvam API failed (${response.status}): ` +
      responseText.slice(0, 1000)
    );
  }

  let apiResult;

  try {
    apiResult = JSON.parse(responseText);
  } catch {
    throw new Error("Sarvam returned an invalid API response.");
  }

  const content =
    apiResult?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      "Sarvam returned an empty research response."
    );
  }

  const parsed = parseSarvamJson(content);

  const subreddits = normalizeSubreddits(
    parsed.subreddits
  );

  const queries = normalizeQueries(
    parsed.queries
  );

  if (subreddits.length !== REQUIRED_SUBREDDIT_COUNT) {
    throw new Error(
      `Expected exactly 5 unique subreddits; received ${subreddits.length}.`
    );
  }

  if (queries.length !== REQUIRED_QUERY_COUNT) {
    throw new Error(
      `Expected exactly 5 unique queries; received ${queries.length}.`
    );
  }

  return {
    subreddits,
    queries
  };
}


// ============================================================
// PARSE SARVAM JSON
// ============================================================

function parseSarvamJson(content) {
  let cleaned = content.trim();

  // Handle a response wrapped in a Markdown code fence.
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(
      "Sarvam did not return valid JSON for Reddit research."
    );
  }
}


// ============================================================
// NORMALIZE SUBREDDIT NAMES
// ============================================================

function normalizeSubreddits(value) {
  if (!Array.isArray(value)) {
    throw new Error(
      "Sarvam response is missing the subreddits array."
    );
  }

  const names = value
    .filter(item => typeof item === "string")
    .map(item =>
      item
        .trim()
        .replace(/^r\//i, "")
        .replace(/^\/+|\/+$/g, "")
    )
    .filter(name => /^[A-Za-z0-9_]+$/.test(name));

  return [...new Set(names)].slice(
    0,
    REQUIRED_SUBREDDIT_COUNT
  );
}


// ============================================================
// NORMALIZE SEARCH QUERIES
// ============================================================

function normalizeQueries(value) {
  if (!Array.isArray(value)) {
    throw new Error(
      "Sarvam response is missing the queries array."
    );
  }

  const queries = value
    .filter(item => typeof item === "string")
    .map(item => item.trim())
    .filter(item => item.length > 0);

  return [...new Set(queries)].slice(
    0,
    REQUIRED_QUERY_COUNT
  );
}


// ============================================================
// UPDATE CUSTOMER NICHE STATUS AND TIMESTAMP
// ============================================================

async function updateNicheStatus(nicheId, status, env) {
  const query = new URLSearchParams({
    id: `eq.${nicheId}`
  });

  await supabaseRequest(
    `/rest/v1/customer_niches?${query.toString()}`,
    env,
    {
      method: "PATCH",
      body: {
        reddit_status: status,
        updated_at: new Date().toISOString()
      },
      prefer: "return=representation",
      requireRows: true
    }
  );
}


// ============================================================
// CREATE THE REDDIT TASK IN planner_runs
// ============================================================

async function createRedditTask(
  application,
  niche,
  taskText,
  env
) {
  const now = new Date().toISOString();

  const task = {
    application_id: application.id,
    user_id: niche.user_id ?? application.user_id ?? null,
    worker_type: REDDIT_WORKER_TYPE,
    source: REDDIT_SOURCE,
    task: taskText,
    pending_count: 5,
    error: null,
    niche: niche.niche_name,
    created_at: now,
    started_at: null,
    status: "pending"
  };

  const rows = await supabaseRequest(
    "/rest/v1/planner_runs",
    env,
    {
      method: "POST",
      body: task,
      prefer: "return=representation",
      requireRows: true
    }
  );

  return rows[0];
}


// ============================================================
// SUPABASE REST HELPER
// ============================================================

async function supabaseRequest(
  path,
  env,
  options = {}
) {
  const url =
    env.SUPABASE_URL.replace(/\/+$/, "") + path;

  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  if (options.prefer) {
    headers["Prefer"] = options.prefer;
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${options.method || "GET"} ${path} failed ` +
      `(${response.status}): ${text.slice(0, 1500)}`
    );
  }

  let data = [];

  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Supabase returned invalid JSON for ${path}.`
      );
    }
  }

  if (!Array.isArray(data)) {
    data = data ? [data] : [];
  }

  if (options.requireRows && data.length === 0) {
    throw new Error(
      `Supabase returned no rows for ${options.method || "GET"} ${path}.`
    );
  }

  return data;
}


// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY"
  ];

  const missing = required.filter(
    key => !env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing Cloudflare secrets: ${missing.join(", ")}`
    );
  }
}


// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
    }
