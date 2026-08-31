import path from "node:path";

const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

export function launchAgentPlist({ label, args, interval, stdout, stderr, workingDirectory, home, configPath, nodeBinary }) {
  const launchPath = `${path.dirname(nodeBinary)}:${systemPath}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escapeXml(home)}</string><key>PATH</key><string>${escapeXml(launchPath)}</string><key>CODEX_WHATSAPP_CONFIG</key><string>${escapeXml(configPath)}</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>${interval}</integer>
<key>StandardOutPath</key><string>${escapeXml(stdout)}</string>
<key>StandardErrorPath</key><string>${escapeXml(stderr)}</string>
</dict></plist>\n`;
}
