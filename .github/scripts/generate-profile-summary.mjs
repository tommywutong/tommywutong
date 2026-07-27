import {mkdir, writeFile} from "node:fs/promises";

const username = "Biscoffee";
const outputDirectory = "profile-summary-card-output/tokyonight";
const token = process.env.GITHUB_TOKEN;

const colors = {
  title: "#70a5fd",
  text: "#38bdae",
  background: "#1a1b27",
  border: "#1a1b27",
  accent: "#bf91f3",
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function abbreviate(value) {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

async function fetchGitHubJson(path, {authenticated = true} = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Biscoffee-profile-summary",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (authenticated && token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchWithRetry(`https://api.github.com${path}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}`);
  }
  return response.json();
}

async function fetchPublicContributionYear(year) {
  const query = new URLSearchParams({
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  });
  const response = await fetchWithRetry(
    `https://github.com/users/${username}/contributions?${query}`,
    {headers: {"User-Agent": "Biscoffee-profile-summary"}},
  );
  if (!response.ok) {
    throw new Error(`Contribution calendar ${response.status} for ${year}`);
  }

  const html = await response.text();
  const tooltips = new Map();
  const tooltipPattern =
    /<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g;
  for (const match of html.matchAll(tooltipPattern)) {
    tooltips.set(match[1], match[2].trim());
  }

  const contributions = [];
  const cellPattern =
    /<td\b[^>]*\bclass="[^"]*ContributionCalendar-day[^"]*"[^>]*><\/td>/g;
  for (const match of html.matchAll(cellPattern)) {
    const cell = match[0];
    const date = cell.match(/\bdata-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
    const id = cell.match(/\bid="([^"]+)"/)?.[1];
    if (!date || !id) continue;

    const label = tooltips.get(id) ?? "";
    const countText = label.match(/^([\d,]+) contributions?\b/)?.[1];
    contributions.push({
      date,
      count: countText ? Number(countText.replaceAll(",", "")) : 0,
    });
  }

  if (contributions.length === 0) {
    throw new Error(`No public contribution cells found for ${year}`);
  }
  return contributions;
}

async function fetchAllPublicRepos() {
  const repositories = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await fetchGitHubJson(
      `/users/${username}/repos?type=owner&sort=full_name&per_page=100&page=${page}`,
    );
    repositories.push(...batch);
    if (batch.length < 100) break;
  }
  return repositories;
}

async function fetchSearchCount(query, endpoint = "issues") {
  const encoded = encodeURIComponent(query);
  const result = await fetchGitHubJson(
    `/search/${endpoint}?q=${encoded}&per_page=1`,
    {authenticated: false},
  );
  return result.total_count;
}

function joinedAgo(createdAt, now) {
  const created = new Date(createdAt);
  let months =
    (now.getUTCFullYear() - created.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    created.getUTCMonth();
  if (now.getUTCDate() < created.getUTCDate()) months -= 1;

  if (months >= 12) {
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }
  if (months > 0) return `${months} month${months === 1 ? "" : "s"} ago`;

  const days = Math.max(
    0,
    Math.floor((now.getTime() - created.getTime()) / 86_400_000),
  );
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function cardFrame({width, height, label, body}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">
  <style>
    text { font-family: "Segoe UI", Ubuntu, "Helvetica Neue", sans-serif; }
  </style>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="5" fill="${colors.background}" stroke="${colors.border}" />
  ${body}
</svg>
`;
}

function renderStatsCard(stats) {
  const rows = stats
    .map((item, index) => {
      const y = 76 + index * 25;
      return `<g transform="translate(30 ${y})">
    <circle cx="7" cy="-5" r="6" fill="${colors.accent}" opacity="0.22" />
    <circle cx="7" cy="-5" r="2.5" fill="${colors.accent}" />
    <text x="22" y="0" font-size="14" fill="${colors.text}">${escapeXml(item.label)}</text>
    <text x="145" y="0" font-size="14" fill="${colors.text}">${escapeXml(abbreviate(item.value))}</text>
  </g>`;
    })
    .join("\n  ");

  return cardFrame({
    width: 340,
    height: 200,
    label: `${username} public GitHub statistics`,
    body: `<text x="30" y="40" font-size="22" fill="${colors.title}">Stats</text>
  ${rows}`,
  });
}

function renderProfileCard({user, contributions, now}) {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
  );
  const months = Array.from({length: 12}, (_, index) => {
    const date = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + index, 1),
    );
    return {
      key: date.toISOString().slice(0, 7),
      label: date.toLocaleString("en", {month: "short", timeZone: "UTC"}),
      count: 0,
    };
  });
  const monthByKey = new Map(months.map((month) => [month.key, month]));
  const todayKey = now.toISOString().slice(0, 10);
  for (const contribution of contributions) {
    if (contribution.date > todayKey) continue;
    const month = monthByKey.get(contribution.date.slice(0, 7));
    if (month) month.count += contribution.count;
  }

  const total = months.reduce((sum, month) => sum + month.count, 0);
  const chart = {left: 292, right: 665, top: 58, bottom: 148};
  const maximum = Math.max(1, ...months.map((month) => month.count));
  const points = months.map((month, index) => {
    const x =
      chart.left + (index / (months.length - 1)) * (chart.right - chart.left);
    const y =
      chart.bottom - (month.count / maximum) * (chart.bottom - chart.top);
    return {x, y, ...month};
  });
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const area = `M${chart.left} ${chart.bottom} ${line.replace(/^M/, "L")} L${chart.right} ${chart.bottom} Z`;
  const grid = [0, 0.5, 1]
    .map((ratio) => {
      const y = chart.bottom - ratio * (chart.bottom - chart.top);
      return `<line x1="${chart.left}" y1="${y}" x2="${chart.right}" y2="${y}" stroke="${colors.text}" opacity="0.12" />`;
    })
    .join("\n  ");
  const labels = points
    .filter((_, index) => index % 2 === 0)
    .map(
      (point) =>
        `<text x="${point.x}" y="171" text-anchor="middle" font-size="10" fill="${colors.text}" opacity="0.8">${point.label}</text>`,
    )
    .join("\n  ");

  const title = user.name ? `${username} (${user.name})` : username;
  const details = [
    `${abbreviate(total)} contributions in 12 months`,
    `${abbreviate(user.public_repos)} public repositories`,
    `Joined GitHub ${joinedAgo(user.created_at, now)}`,
  ];
  if (user.location) {
    details.push(user.location.replace(/\s*,\s*/g, ", "));
  }

  const detailRows = details
    .slice(0, 4)
    .map(
      (value, index) => `<g transform="translate(30 ${76 + index * 28})">
    <circle cx="7" cy="-5" r="6" fill="${colors.accent}" opacity="0.22" />
    <circle cx="7" cy="-5" r="2.5" fill="${colors.accent}" />
    <text x="22" y="0" font-size="14" fill="${colors.text}">${escapeXml(value)}</text>
  </g>`,
    )
    .join("\n  ");

  return cardFrame({
    width: 700,
    height: 200,
    label: `${username} visible GitHub profile summary`,
    body: `<text x="30" y="40" font-size="22" fill="${colors.title}">${escapeXml(title)}</text>
  ${detailRows}
  ${grid}
  <path d="${area}" fill="${colors.accent}" opacity="0.22" />
  <path d="${line}" fill="none" stroke="${colors.accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
  ${labels}`,
  });
}

async function main() {
  const now = new Date();
  const years = [now.getUTCFullYear() - 1, now.getUTCFullYear()];
  const [user, repositories, commits, pullRequests, issues, ...yearData] =
    await Promise.all([
      fetchGitHubJson(`/users/${username}`),
      fetchAllPublicRepos(),
      fetchSearchCount(`author:${username}`, "commits"),
      fetchSearchCount(`author:${username} type:pr`),
      fetchSearchCount(`author:${username} type:issue`),
      ...years.map(fetchPublicContributionYear),
    ]);

  const stats = [
    {
      label: "Total Stars:",
      value: repositories.reduce(
        (sum, repository) => sum + repository.stargazers_count,
        0,
      ),
    },
    {label: "Public Commits:", value: commits},
    {label: "Public PRs:", value: pullRequests},
    {label: "Public Issues:", value: issues},
    {label: "Public Repos:", value: user.public_repos},
  ];

  await mkdir(outputDirectory, {recursive: true});
  await Promise.all([
    writeFile(
      `${outputDirectory}/0-profile-details.svg`,
      renderProfileCard({
        user,
        contributions: yearData.flat(),
        now,
      }),
    ),
    writeFile(
      `${outputDirectory}/3-stats.svg`,
      renderStatsCard(stats),
    ),
  ]);
}

await main();
