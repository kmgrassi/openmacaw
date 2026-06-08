export function printTrace(result) {
  console.log(`agent trace: ${result.status}`);
  console.log(`since: ${result.since}`);
  console.log(
    `identifiers: ${Object.entries(result.identifiers)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")}`,
  );
  console.log("");
  const nameWidth = Math.max(
    ...result.checks.map((item) => item.layer.length),
    5,
  );
  for (const item of result.checks) {
    console.log(
      `${item.status.padEnd(5)} ${item.layer.padEnd(nameWidth)} ${item.summary}`,
    );
    if (item.next) {
      console.log(`${"".padEnd(6 + nameWidth)} next: ${item.next}`);
    }
  }
}

export function check(layer, status, summary, details = {}) {
  return compact({ layer, status, summary, ...details });
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null && item !== "",
    ),
  );
}
