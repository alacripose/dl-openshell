// Drive the shipped Popit and landing page in headless Chromium (Edge or Chrome) and report what
// the browser actually rendered.
//
//   node tools/browser_probe.js                 # run both probes, write the receipt
//   node tools/browser_probe.js --probe         # only the Popit page
//   node tools/browser_probe.js --landing       # only the landing page
//   node tools/browser_probe.js --browser <exe> # choose the Chromium binary
//
// The runner serves the repository over loopback (so the probe loads the real scripts and
// stylesheets with normal same-origin rules), speaks CDP over the DevTools WebSocket, and reads
// results from the DOM. No dependency is installed: Node 22 has fetch and WebSocket.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RECEIPT = path.join(ROOT, "artifacts", "receipts", "browser-probe.json");
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".woff2": "font/woff2"
};

function findBrowser(explicit) {
    const candidates = [
        explicit,
        process.env.OPENLOCK_CHROMIUM,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium"
    ].filter(Boolean);
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
    throw new Error("no Chromium binary found; pass --browser <path>");
}

function startServer() {
    const server = http.createServer((request, response) => {
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
        } catch (error) {
            response.writeHead(400).end("bad url");
            return;
        }
        if (pathname === "/") pathname = "/index.html";
        const file = path.resolve(ROOT, "." + pathname);
        if (!file.startsWith(ROOT + path.sep)) {
            response.writeHead(403).end("outside root");
            return;
        }
        fs.readFile(file, (error, body) => {
            if (error) {
                response.writeHead(404, { "content-type": "text/plain" }).end("not found: " + pathname);
                return;
            }
            response.writeHead(200, {
                "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
                "cache-control": "no-store"
            });
            response.end(body);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

async function launchBrowser(binary) {
    const port = 9400 + Math.floor(Math.random() * 300);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openlock-cdp-"));
    const child = spawn(binary, [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--hide-scrollbars",
        "--mute-audio",
        "--remote-debugging-port=" + port,
        "--user-data-dir=" + profile,
        "about:blank"
    ], { stdio: "ignore", windowsHide: true });

    const deadline = Date.now() + 20000;
    let version = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) { version = await response.json(); break; }
        } catch (error) { /* not up yet */ }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!version) {
        child.kill();
        throw new Error("the browser did not expose a DevTools endpoint");
    }
    return { child, port, profile, version };
}

async function openPage(port) {
    let target = null;
    for (const method of ["PUT", "GET"]) {
        const response = await fetch(`http://127.0.0.1:${port}/json/new?url=about:blank`, { method });
        if (response.ok) { target = await response.json(); break; }
    }
    if (!target) throw new Error("could not open a browser target");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("DevTools socket failed")), { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) entry.reject(new Error(message.method + ": " + message.error.message));
            else entry.resolve(message.result);
            return;
        }
        for (const listener of listeners) listener(message);
    });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });

    const on = (listener) => listeners.push(listener);
    const waitEvent = (method, timeout = 20000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + method)), timeout);
        const listener = (message) => {
            if (message.method !== method) return;
            clearTimeout(timer);
            listeners.splice(listeners.indexOf(listener), 1);
            resolve(message.params);
        };
        listeners.push(listener);
    });

    return { socket, send, on, waitEvent, target };
}

async function evaluate(page, expression) {
    const result = await page.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
    });
    if (result.exceptionDetails) {
        throw new Error("page exception: " + (result.exceptionDetails.exception && result.exceptionDetails.exception.description ||
            result.exceptionDetails.text));
    }
    return result.result ? result.result.value : undefined;
}

function attachDiagnostics(page) {
    const state = { consoleErrors: [], exceptions: [], logErrors: [], failedRequests: [], requests: new Map() };
    page.on((message) => {
        if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
            state.consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || arg.type).join(" "));
        } else if (message.method === "Runtime.exceptionThrown") {
            const details = message.params.exceptionDetails;
            state.exceptions.push(details.exception && details.exception.description || details.text);
        } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
            const entry = message.params.entry;
            state.logErrors.push(entry.text + (entry.url ? " (" + entry.url + ")" : ""));
        } else if (message.method === "Network.requestWillBeSent") {
            state.requests.set(message.params.requestId, message.params.request.url);
        } else if (message.method === "Network.loadingFailed") {
            state.failedRequests.push({
                url: state.requests.get(message.params.requestId) || "(unknown)",
                error: message.params.errorText,
                canceled: !!message.params.canceled
            });
        }
    });
    const reset = () => {
        state.consoleErrors.length = 0;
        state.exceptions.length = 0;
        state.logErrors.length = 0;
        state.failedRequests.length = 0;
        state.requests.clear();
        return state;
    };
    return { state, reset };
}

async function navigate(page, url, settle = 250) {
    const loaded = page.waitEvent("Page.loadEventFired", 30000);
    await page.send("Page.navigate", { url });
    await loaded;
    if (settle) await new Promise((resolve) => setTimeout(resolve, settle));
}

async function waitForProbe(page, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const done = await evaluate(page, "document.documentElement.dataset.probeDone || ''");
        if (done === "1") return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

function classify(state) {
    const local = (url) => url.startsWith("http://127.0.0.1");
    const external = (text) => /fonts\.g(oogleapis|static)\.com/.test(text);
    return {
        consoleErrors: state.consoleErrors.filter((text) => !external(text)),
        exceptions: state.exceptions,
        logErrors: state.logErrors.filter((text) => !external(text)),
        externalFailures: state.logErrors.filter(external).concat(
            state.failedRequests.filter((entry) => !local(entry.url)).map((entry) => entry.url + ": " + entry.error)
        ),
        failedLocalRequests: state.failedRequests.filter((entry) => local(entry.url))
    };
}

async function runProbe(page, baseUrl, diagnostics) {
    diagnostics.reset();
    await page.send("Emulation.setDeviceMetricsOverride", {
        width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
    });
    await navigate(page, baseUrl + "/tools/browser/popit-probe.html", 100);
    const done = await waitForProbe(page);
    const text = await evaluate(page, "document.getElementById('probe-output').textContent");
    let report;
    try {
        report = JSON.parse(text);
    } catch (error) {
        report = { ok: false, checks: [], failures: ["probe output was not JSON: " + text.slice(0, 400) + " (" + error.message + ")"] };
    }
    const diagnosticsResult = classify(diagnostics.state);
    if (!done) report.failures.push("the probe did not finish in 30s");
    if (diagnosticsResult.exceptions.length || diagnosticsResult.consoleErrors.length || diagnosticsResult.logErrors.length) {
        for (const failure of diagnosticsResult.exceptions.concat(diagnosticsResult.consoleErrors, diagnosticsResult.logErrors)) {
            report.failures.push("browser error: " + failure);
        }
    }
    for (const failure of diagnosticsResult.failedLocalRequests) {
        report.failures.push("missing local asset: " + failure.url + " (" + failure.error + ")");
    }
    report.ok = report.failures.length === 0;
    return { report, diagnostics: diagnosticsResult };
}

function landingVerdict(measured) {
    const failures = [];
    const need = (ok, name) => { if (!ok) failures.push(name); };
    need(!!measured, "the landing measurement returned nothing");
    if (!measured) return failures;
    need(measured.root && measured.root.h > 40, "the Popit root mock has no rendered height");
    need(measured.child && measured.child.h > 40, "the Popit child mock has no rendered height");
    need(measured.rootVisible && measured.childVisible, "the Popit mock is not visible");
    need(measured.rows === 6, `the root mock shows ${measured.rows} rows instead of 6`);
    need(measured.pairs === 8, `the pair grid shows ${measured.pairs} tiles instead of 8`);
    need(measured.bands === 8, `the pair grid shows ${measured.bands} bands instead of 8`);
    need(measured.bandHeights.every((height) => height >= 8), "a pair band has no rendered height: " + measured.bandHeights.join(","));
    need(measured.bandChildren.every((count) => count === 3), "a pair band does not carry three colours");
    need(measured.bandColors.every((colors) => colors.length === 3 && colors.every((color) => color && color !== "rgba(0, 0, 0, 0)")),
        "a pair band colour is missing: " + JSON.stringify(measured.bandColors));
    need(!measured.overlap, "the Popit root and child overlap");
    need(measured.planes === 4, `the control-plane table shows ${measured.planes} rows instead of 4`);
    need(measured.overflowX <= 1, `the page overflows horizontally by ${measured.overflowX}px`);
    need(measured.pairText > 400, "the Popit section has little rendered text");
    return failures;
}

async function runLanding(page, baseUrl, diagnostics, viewports) {
    const results = [];
    for (const viewport of viewports) {
        diagnostics.reset();
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 600
        });
        await navigate(page, baseUrl + "/landing/index.html", 500);
        await evaluate(page, "document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true");
        const measured = await evaluate(page, fs.readFileSync(path.join(__dirname, "browser", "landing-measure.js"), "utf8"));
        const failures = landingVerdict(measured);
        const diagnosticsResult = classify(diagnostics.state);
        for (const failure of diagnosticsResult.exceptions.concat(diagnosticsResult.consoleErrors, diagnosticsResult.logErrors)) {
            failures.push("browser error: " + failure);
        }
        for (const failure of diagnosticsResult.failedLocalRequests) {
            failures.push("missing local asset: " + failure.url + " (" + failure.error + ")");
        }
        const auditLine = await evaluate(page, "document.querySelector('.audit-line') ? document.querySelector('.audit-line').innerText.replace(/\\s+/g, ' ') : ''");
        results.push({
            viewport,
            ok: failures.length === 0,
            failures,
            measured,
            auditLine,
            externalFailures: diagnosticsResult.externalFailures
        });
    }
    return results;
}

function summary(result) {
    const lines = [];
    lines.push("Popit browser probe: " + (result.probe.report.ok ? "held" : "refused"));
    for (const entry of result.probe.report.checks) {
        lines.push("  " + (entry.ok ? "ok" : "FAIL") + " - " + entry.name + (entry.detail ? " [" + entry.detail + "]" : ""));
    }
    for (const failure of result.probe.report.failures) lines.push("  REFUSED - " + failure);
    lines.push("Landing page:");
    for (const run of result.landing) {
        lines.push("  " + run.viewport.width + "x" + run.viewport.height + ": " + (run.ok ? "held" : "refused") +
            " root " + (run.measured ? run.measured.root.w + "x" + run.measured.root.h : "?") +
            ", child " + (run.measured ? run.measured.child.w + "x" + run.measured.child.h : "?") +
            ", overflowX " + (run.measured ? run.measured.overflowX : "?"));
        for (const failure of run.failures) lines.push("    REFUSED - " + failure);
    }
    const localErrors = result.probe.diagnostics.consoleErrors.length + result.probe.diagnostics.logErrors.length +
        result.probe.diagnostics.exceptions.length;
    lines.push("  browser errors (local): " + localErrors);
    const external = new Set();
    for (const run of result.landing) for (const failure of run.externalFailures) external.add(failure.split(":")[0]);
    if (external.size) lines.push("  external font requests that did not complete: " + Array.from(external).join(", "));
    lines.push("RESULT: " + (result.ok ? "browser-probe held" : "browser-probe refused"));
    return lines.join("\n");
}

async function main() {
    const argv = process.argv.slice(2);
    const explicit = argv.indexOf("--browser") >= 0 ? argv[argv.indexOf("--browser") + 1] : "";
    const onlyProbe = argv.includes("--probe");
    const onlyLanding = argv.includes("--landing");
    const binary = findBrowser(explicit);
    const { server, port: httpPort } = await startServer();
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    let browser = null;
    let page = null;
    try {
        browser = await launchBrowser(binary);
        page = await openPage(browser.port);
        await page.send("Runtime.enable");
        await page.send("Page.enable");
        await page.send("Log.enable");
        await page.send("Network.enable");
        const diagnostics = attachDiagnostics(page);

        const result = {
            format: "openlock.browser-probe/1",
            browser: browser.version["User-Agent"] || browser.version.Browser,
            binary,
            probe: { report: { ok: true, checks: [], failures: [] }, diagnostics: {} },
            landing: [],
            ok: true
        };

        if (!onlyLanding) {
            result.probe = await runProbe(page, baseUrl, diagnostics);
            result.ok = result.ok && result.probe.report.ok;
        }
        if (!onlyProbe) {
            result.landing = await runLanding(page, baseUrl, diagnostics, [
                { width: 1280, height: 900 },
                { width: 420, height: 900 }
            ]);
            result.ok = result.ok && result.landing.every((run) => run.ok);
        }

        fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
        fs.writeFileSync(RECEIPT, JSON.stringify(result, null, 2) + "\n");
        console.log(summary(result));
        return result.ok ? 0 : 1;
    } finally {
        try { if (page && page.socket) page.socket.close(); } catch (error) { /* closed */ }
        try { if (browser && browser.child) browser.child.kill(); } catch (error) { /* gone */ }
        server.close();
        if (browser) {
            try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch (error) { /* locked */ }
        }
    }
}

main().then((code) => process.exit(code)).catch((error) => {
    console.error("browser probe failed to run: " + (error && error.stack ? error.stack : error));
    process.exit(2);
});
