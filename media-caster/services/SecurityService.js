const { exec } = require('child_process');
const path = require('path');

class SecurityService {
    constructor(logger = console) {
        this.log = logger;
    }

    /**
     * Executes a shell command and returns a promise.
     */
    async _execCommand(command, cwd) {
        return new Promise((resolve, reject) => {
            exec(command, { cwd }, (error, stdout, stderr) => {
                if (error) {
                    // npm audit fix might exit with code 1 if there are still vulnerabilities left, 
                    // we don't necessarily want to fail the whole process if it fixed *some*.
                    resolve({ error, stdout, stderr, code: error.code });
                } else {
                    resolve({ error: null, stdout, stderr, code: 0 });
                }
            });
        });
    }

    /**
     * Runs npm audit fix in a specified directory.
     */
    async _runAuditFix(targetDir) {
        this.log.log(`🔒 [SecurityService] Running 'npm audit fix' in ${targetDir}...`);
        const { stdout, stderr, code } = await this._execCommand('npm audit fix', targetDir);
        this.log.log(`🔒 [SecurityService] npm audit fix output (code ${code}):\n${stdout}`);
        if (stderr) {
            this.log.log(`⚠️ [SecurityService] npm audit fix stderr:\n${stderr}`);
        }
    }

    /**
     * Commits and pushes any package.json / package-lock.json changes.
     */
    async _commitAndPushChanges(projectRoot) {
        this.log.log(`🔒 [SecurityService] Checking for git changes...`);
        const { stdout: statusOut } = await this._execCommand('git status --porcelain', projectRoot);
        
        if (!statusOut || statusOut.trim() === '') {
            this.log.log(`✅ [SecurityService] No changes detected after audit fix.`);
            return;
        }

        const hasPackageChanges = statusOut.includes('package.json') || statusOut.includes('package-lock.json') || statusOut.includes('ip-patch');
        
        if (!hasPackageChanges) {
            this.log.log(`✅ [SecurityService] No package files modified. Skipping commit.`);
            return;
        }

        this.log.log(`🔒 [SecurityService] Found package file changes. Committing and pushing...`);
        
        // Add package files
        await this._execCommand('git add package.json package-lock.json', projectRoot);
        await this._execCommand('git add media-caster/package.json media-caster/package-lock.json media-caster/ip-patch', projectRoot);

        // Commit
        const commitCmd = `git commit -m "chore(security): auto-fix dependabot vulnerabilities and enforce overrides"`;
        const { stdout: commitOut, stderr: commitErr } = await this._execCommand(commitCmd, projectRoot);
        this.log.log(`🔒 [SecurityService] Commit output:\n${commitOut}`);
        if (commitErr) this.log.log(`⚠️ [SecurityService] Commit stderr:\n${commitErr}`);

        // Push
        const pushCmd = `git push origin main`;
        const { stdout: pushOut, stderr: pushErr, code: pushCode } = await this._execCommand(pushCmd, projectRoot);
        if (pushCode === 0) {
            this.log.log(`✅ [SecurityService] Successfully pushed security fixes to remote.`);
        } else {
            this.log.log(`❌ [SecurityService] Failed to push security fixes. Output:\n${pushOut}\nStderr:\n${pushErr}`);
        }
    }

    /**
     * Enforces package overrides for vulnerabilities that npm audit fix cannot resolve.
     */
    async _enforceOverridesForRemainingVulnerabilities(targetDir) {
        const fs = require('fs');
        const path = require('path');
        
        this.log.log(`🔍 [SecurityService] Checking for unfixable vulnerabilities in ${targetDir}...`);
        const { stdout } = await this._execCommand('npm audit --json', targetDir);
        
        let auditData;
        try {
            auditData = JSON.parse(stdout);
        } catch (e) {
            return; // No valid JSON, likely no vulnerabilities or a parsing error
        }

        if (!auditData.vulnerabilities || Object.keys(auditData.vulnerabilities).length === 0) {
            this.log.log(`✅ [SecurityService] No remaining vulnerabilities in ${targetDir}.`);
            return;
        }

        let overridesAdded = false;
        const packageJsonPath = path.join(targetDir, 'package.json');
        
        if (!fs.existsSync(packageJsonPath)) return;

        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        pkg.overrides = pkg.overrides || {};

        for (const [vulnName, vulnDetails] of Object.entries(auditData.vulnerabilities)) {
            if (vulnDetails.severity === 'high' || vulnDetails.severity === 'critical') {
                if (!pkg.overrides[vulnName] && vulnName !== 'ip') { // skip 'ip' as we use a custom file patch
                    this.log.log(`⚠️ [SecurityService] Unfixable ${vulnDetails.severity} vulnerability found in ${vulnName}. Enforcing latest version override.`);
                    pkg.overrides[vulnName] = "*"; // Force resolution to latest
                    overridesAdded = true;
                }
            }
        }

        if (overridesAdded) {
            fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
            this.log.log(`🔄 [SecurityService] Overrides updated in ${targetDir}. Running npm install...`);
            await this._execCommand('npm install', targetDir);
            this.log.log(`✅ [SecurityService] npm install complete after applying overrides.`);
        }
    }

    /**
     * Main orchestration method to be called post-midnight.
     */
    async autoFixVulnerabilities() {
        this.log.log(`🛡️  [SecurityService] Starting daily Dependabot auto-fix routine...`);
        try {
            const projectRoot = path.join(__dirname, '../../');
            const mediaCasterDir = path.join(__dirname, '../');

            // 1. Run audit fix in project root
            await this._runAuditFix(projectRoot);
            await this._enforceOverridesForRemainingVulnerabilities(projectRoot);

            // 2. Run audit fix in media-caster directory
            await this._runAuditFix(mediaCasterDir);
            await this._enforceOverridesForRemainingVulnerabilities(mediaCasterDir);

            // 3. Commit and push
            await this._commitAndPushChanges(projectRoot);

            this.log.log(`🛡️  [SecurityService] Daily Dependabot auto-fix routine completed.`);
        } catch (error) {
            this.log.error(`❌ [SecurityService] Error during auto-fix routine: ${error.message}`);
        }
    }
}

module.exports = SecurityService;
