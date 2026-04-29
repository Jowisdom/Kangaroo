const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
    process.exit(0);
}

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'build', 'copy-file-to-clipboard.m');
const outputPath = path.join(root, 'build', 'copy-file-to-clipboard');
const helperAppPath = path.join(root, 'build', 'copy-file-to-clipboard.app');
const helperAppContentsPath = path.join(helperAppPath, 'Contents');
const helperAppMacOsPath = path.join(helperAppContentsPath, 'MacOS');
const helperAppExecutablePath = path.join(helperAppMacOsPath, 'copy-file-to-clipboard');
const helperAppInfoPath = path.join(helperAppContentsPath, 'Info.plist');

if (!fs.existsSync(sourcePath)) {
    process.exit(0);
}

const result = spawnSync('clang', [
    '-fobjc-arc',
    '-framework',
    'Cocoa',
    sourcePath,
    '-o',
    outputPath
], {
    cwd: root,
    encoding: 'utf8'
});

if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || 'unable to build macOS clipboard helper').trim();
    console.warn(`Warning: ${message}`);
    process.exit(0);
}

try {
    fs.chmodSync(outputPath, 0o755);
} catch {
    // The helper may still be executable when chmod is unavailable.
}

try {
    fs.mkdirSync(helperAppMacOsPath, { recursive: true });
    fs.copyFileSync(outputPath, helperAppExecutablePath);
    fs.chmodSync(helperAppExecutablePath, 0o755);
    fs.writeFileSync(helperAppInfoPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>copy-file-to-clipboard</string>
    <key>CFBundleIdentifier</key>
    <string>com.yourname.kangaroo.copy-file-to-clipboard</string>
    <key>CFBundleName</key>
    <string>Kangaroo Clipboard Helper</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSBackgroundOnly</key>
    <true/>
</dict>
</plist>
`, 'utf8');
} catch (error) {
    console.warn(`Warning: unable to build macOS clipboard helper app: ${error.message}`);
}
