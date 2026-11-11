const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const net = require("node:net")
const { spawn, spawnSync } = require("node:child_process")
const { setTimeout: delay } = require("node:timers/promises")

const available = process.platform === "linux"
  && spawnSync("quickshell", ["--version"]).status === 0
  && spawnSync("python3", ["--version"]).status === 0

function socketFixture(component, socketPath) {
  const source = fs.readFileSync(path.join(__dirname, "..", component), "utf8")
  // Exercise the production Socket, including its parser and lifecycle handlers,
  // without loading any shell UI or contacting the user's real monitor daemon.
  const socket = source.match(/^  Socket \{[\s\S]*?^  }/m)
  assert.ok(socket, `${component} must contain its backend socket`)
  return `import QtQuick
import Quickshell
import Quickshell.Io
Item {
  id: root
  property string socketPath: ${JSON.stringify(socketPath)}
  property bool connectionGrace: true
  property string lastError: "old error"
  property bool installing: true
  property var pendingMethods: ({ one: "status" })
  property var pendingContexts: ({ one: {} })
  property bool editorReady: true
  property bool editorLoading: true
  property bool editorRefreshQueued: true
  property bool editorResetQueued: true
  property int monitorTopologyRevision: 0
  property bool editPending: true
  property bool profileModePending: true
  property bool reusePending: true
  property int reuseGeneration: 0
  property bool statusRetry: true
  property bool editorRetry: true
  property bool displaysConnecting: true
  property bool compatible: true
  property bool serviceEnabled: true
  property bool serviceActive: true
  property int identifyTopologyRevision: 0
  property bool requestPending: true
  property bool identifyPending: true
  function subscribe() { send("subscribe", {}) }
  function send(method, params) {
    requestPending = true
    backendSocket.write(method + "\\n")
    backendSocket.flush()
  }
  function handleMessage(line) { console.log("RECEIVED " + line) }
  function clearPreview(refresh) {
    console.log("PANEL_DISCONNECTED " + JSON.stringify({
      pendingMethods: pendingMethods, pendingContexts: pendingContexts,
      editorReady: editorReady, editorLoading: editorLoading,
      editPending: editPending, profileModePending: profileModePending,
      reusePending: reusePending, statusRetry: statusRetry,
      editorRetry: editorRetry, displaysConnecting: displaysConnecting
    }))
  }
  function cancelIdentify() { identifyPending = false }
  function clear() {
    requestPending = false
    console.log("GUARD_DISCONNECTED " + JSON.stringify({
      pendingMethods: pendingMethods, pendingContexts: pendingContexts,
      identifyPending: identifyPending, requestPending: requestPending
    }))
  }
  function requestFinished(success, message) { console.log("REQUEST_FAILED " + message) }
  Timer { id: serviceRefreshTimer; interval: 1 }
  Timer {
    interval: 50
    repeat: true
    running: !backendSocket.connected
    onTriggered: backendSocket.connected = true
  }
  Component.onCompleted: backendSocket.connected = true
${socket[0]}
}`
}

async function waitUntil(check, detail, output) {
  const deadline = Date.now() + 4000
  while (!check()) {
    assert.ok(Date.now() < deadline, `${detail}\n${output()}`)
    await delay(20)
  }
}

for (const component of ["Panel.qml", "PreviewGuard.qml"]) {
  test(`${component} survives daemon loss and reconnects with native Socket cleanup`,
    { skip: !available, timeout: 15000 }, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hyprmoncfg-socket-"))
      const socketPath = path.join(directory, "backend.sock")
      const config = path.join(directory, "shell.qml")
      fs.writeFileSync(config, socketFixture(component, socketPath))
      let output = ""
      let child
      let server
      const connections = new Set()
      let subscriptions = 0
      const env = { ...process.env, QT_QPA_PLATFORM: "offscreen",
        QT_QUICK_BACKEND: "software", QT_STYLE_OVERRIDE: "Fusion",
        QT_QPA_PLATFORMTHEME: "", QS_DISABLE_CRASH_HANDLER: "1",
        XDG_RUNTIME_DIR: directory, XDG_CONFIG_HOME: directory,
        XDG_CACHE_HOME: directory, NO_COLOR: "1" }
      delete env.WAYLAND_DISPLAY
      delete env.DISPLAY
      try {
        // Disable core dumping before exec as well as Quickshell's restart and
        // report windows. A regression stays confined to this test process.
        child = spawn("python3", ["-c",
          "import os,resource,sys; resource.setrlimit(resource.RLIMIT_CORE,(0,0)); os.execvp(sys.argv[1],sys.argv[1:])",
          "quickshell", "-p", config], { env, stdio: ["ignore", "pipe", "pipe"] })
        child.stdout.on("data", data => { output += data })
        child.stderr.on("data", data => { output += data })
        child.on("exit", (code, signal) => { output += `\nCHILD_EXIT code=${code} signal=${signal}\n` })
        // Start absent to cover connection failure as well as peer closure.
        await waitUntil(() => /ServerNotFoundError/.test(output), "missing socket error", () => output)
        for (let cycle = 0; cycle < 5; cycle++) {
          server = net.createServer(connection => {
            connections.add(connection)
            let input = ""
            connection.on("data", data => {
              input += data
              if (input.includes("subscribe\n")) {
                input = ""
                subscriptions++
                connection.write(`cycle-${cycle}\n`)
              }
            })
            connection.on("error", () => {})
            connection.on("close", () => connections.delete(connection))
          })
          await new Promise((resolve, reject) => {
            server.once("error", reject)
            server.listen(socketPath, resolve)
          })
          await waitUntil(() => subscriptions === cycle + 1 && output.includes(`RECEIVED cycle-${cycle}`),
            `reconnection ${cycle + 1}`, () => output)
          const oldDisconnects = (output.match(/(?:PANEL|GUARD)_DISCONNECTED/g) || []).length
          const closed = new Promise(resolve => server.close(resolve))
          for (const connection of connections) connection.destroy()
          await closed
          server = null
          await waitUntil(() => (output.match(/(?:PANEL|GUARD)_DISCONNECTED/g) || []).length > oldDisconnects,
            `disconnect ${cycle + 1}`, () => output)
          assert.equal(child.exitCode, null, output)
          assert.equal(child.signalCode, null, output)
          await delay(100)
        }
        assert.match(output, /PeerClosedError/)
        const statePrefix = component === "Panel.qml" ? "PANEL_DISCONNECTED" : "GUARD_DISCONNECTED"
        const states = Array.from(output.matchAll(new RegExp(statePrefix + " (\\{[^\\n]+\\})", "g")),
          match => JSON.parse(match[1]))
        assert.equal(states.length, 5, output)
        for (const state of states) {
          assert.deepEqual(state.pendingMethods, {})
          assert.deepEqual(state.pendingContexts, {})
          for (const [key, value] of Object.entries(state)) {
            if (key !== "pendingMethods" && key !== "pendingContexts")
              assert.equal(value, false, key)
          }
        }
        if (component === "PreviewGuard.qml")
          assert.equal((output.match(/REQUEST_FAILED /g) || []).length, 5, output)
      } finally {
        for (const connection of connections) connection.destroy()
        if (server) await new Promise(resolve => server.close(resolve))
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise(resolve => child.once("exit", resolve))
          child.kill("SIGTERM")
          await exited
        }
        fs.rmSync(directory, { recursive: true, force: true })
      }
    })
}
