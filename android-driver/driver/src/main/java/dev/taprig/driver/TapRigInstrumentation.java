package dev.taprig.driver;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class TapRigInstrumentation extends Instrumentation {
    private static final int PROTOCOL_VERSION = 1;
    private static final int ACTION_WAIT_MS = 2_000;
    private static final int EVENT_SETTLE_MS = 50;
    private static final int SETTLE_QUIET_MS = 300;
    private static final String SOCKET_NAME = "taprig-driver";

    private final Object changeMonitor = new Object();
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicLong events = new AtomicLong();
    private final String sessionId = newSessionId();
    private volatile boolean running = true;
    private String nonce;
    private String lastFingerprint;
    private UiAutomation automation;
    private LocalServerSocket server;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        nonce = arguments == null ? null : arguments.getString("nonce");
        if (!Validators.validNonce(nonce)) {
            Bundle result = new Bundle();
            result.putString("error", "missing or invalid nonce");
            finish(Activity.RESULT_CANCELED, result);
            return;
        }
        start();
    }

    @Override
    public void onStart() {
        try {
            automation = getUiAutomation();
            AccessibilityServiceInfo info = automation.getServiceInfo();
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                    | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            automation.setServiceInfo(info);
            automation.setOnAccessibilityEventListener(this::changed);
            server = new LocalServerSocket(SOCKET_NAME);
            while (running) {
                LocalSocket socket;
                try {
                    socket = server.accept();
                } catch (IOException error) {
                    if (running) throw error;
                    break;
                }
                // One host connection at a time; a dropped connection only ends that connection.
                try (LocalSocket connection = socket) {
                    serve(connection);
                } catch (IOException ignored) {
                }
            }
            finish(Activity.RESULT_OK, new Bundle());
        } catch (Exception error) {
            Bundle result = new Bundle();
            result.putString("error", safeMessage(error));
            finish(Activity.RESULT_CANCELED, result);
        } finally {
            close(server);
            if (automation != null) automation.setOnAccessibilityEventListener(null);
        }
    }

    private void serve(LocalSocket socket) throws IOException {
        BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
        BufferedOutputStream output = new BufferedOutputStream(socket.getOutputStream());
        boolean authenticated = false;
        while (running) {
            String line = readLine(input);
            if (line == null) return;
            String id = "unknown";
            try {
                JSONObject request = new JSONObject(line);
                id = request.optString("id", "");
                if (!Validators.validId(id)) throw new DriverError("invalid-request", "invalid request id");
                String type = request.optString("type", "");
                if (!authenticated) {
                    if (!"hello".equals(type)) throw new DriverError("unauthorized", "hello required");
                    if (request.optInt("version", -1) != PROTOCOL_VERSION) {
                        throw new DriverError("unsupported-version", "protocol version must be 1");
                    }
                    if (!constantTimeEquals(nonce, request.optString("nonce", ""))) {
                        throw new DriverError("unauthorized", "invalid session nonce");
                    }
                    authenticated = true;
                    send(output, success(id, new JSONObject().put("version", PROTOCOL_VERSION).put("nonce", nonce)));
                    continue;
                }
                send(output, dispatch(id, type, request));
            } catch (DriverError error) {
                send(output, failure(id, error.code, error.getMessage()));
            } catch (JSONException | IllegalArgumentException error) {
                send(output, failure(id, "invalid-request", safeMessage(error)));
            } catch (Exception error) {
                send(output, failure(id, "driver-failed", safeMessage(error)));
            }
        }
    }

    private JSONObject dispatch(String id, String type, JSONObject request) throws Exception {
        return switch (type) {
            case "health" -> success(id, health());
            case "snapshot" -> {
                try (TreeState state = capture()) {
                    yield success(id, state.toJson());
                }
            }
            case "wait" -> success(
                    id,
                    waitForChange(
                            request.optString("afterGeneration", ""),
                            Validators.waitMillis(request.optInt("timeoutMs", 0))));
            case "perform" -> success(id, perform(
                    request.optString("expectedGeneration", ""),
                    requiredObject(request, "action")));
            case "stop" -> {
                running = false;
                close(server);
                yield success(id, new JSONObject().put("stopped", true));
            }
            default -> throw new DriverError("invalid-request", "unknown request type");
        };
    }

    private JSONObject health() throws JSONException {
        return new JSONObject().put("version", PROTOCOL_VERSION).put("generation", generation());
    }

    private JSONObject waitForChange(String afterGeneration, int timeoutMs) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        while (true) {
            long seen = events.get();
            try (TreeState state = capture()) {
                if (!state.generation.equals(afterGeneration)) {
                    return new JSONObject().put("changed", true).put("snapshot", state.toJson());
                }
            }
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) return new JSONObject().put("changed", false).put("snapshot", JSONObject.NULL);
            synchronized (changeMonitor) {
                if (events.get() == seen) changeMonitor.wait(remaining);
            }
            // Coalesce event bursts so one navigation costs a few captures, not one per event.
            SystemClock.sleep(Math.min(EVENT_SETTLE_MS, Math.max(0, deadline - SystemClock.elapsedRealtime())));
        }
    }

    private JSONObject perform(String expectedGeneration, JSONObject action) throws Exception {
        if (expectedGeneration.trim().isEmpty()) {
            throw new DriverError("invalid-request", "expectedGeneration is required");
        }
        String before;
        boolean secureText = false;
        try (TreeState state = capture()) {
            before = state.generation;
            String type = action.optString("type", "");
            // Agents decide for seconds while screens animate. Only actions whose meaning depends on the
            // exact earlier layout (coordinates, positional element IDs) require that layout; semantic
            // selectors are resolved against the live tree and global actions mean the same anywhere.
            if (!before.equals(expectedGeneration) && needsExactScreen(type, action)) {
                throw new DriverError("stale-observation", "phone state changed before action");
            }
            boolean dispatched = switch (type) {
                case "element.tap" -> tap(resolve(state, requiredObject(action, "target")), false);
                case "element.longTap" -> tap(resolve(state, requiredObject(action, "target")), true);
                case "element.text" -> {
                    AccessibilityNodeInfo field = resolve(state, requiredObject(action, "target"));
                    secureText = field.isPassword();
                    yield setText(field, requiredString(action, "value", 10_000), action.optBoolean("clear", false));
                }
                case "key.press" -> pressKey(requiredString(action, "key", 20));
                case "gesture.tap" -> injectTap(requiredCoordinate(action, "x"), requiredCoordinate(action, "y"), false);
                case "gesture.swipe" -> swipe(action);
                case "app.launch" -> launch(requiredPackage(action, "packageName"));
                default -> throw new DriverError("unsupported-action", "unsupported action type");
            };
            if (!dispatched) throw new DriverError("verification-failed", "Android rejected the action");
        }

        JSONObject next = waitForChange(before, ACTION_WAIT_MS);
        if (!next.getBoolean("changed") && "gesture.tap".equals(action.optString("type"))) {
            // Coordinate taps serve vision surfaces (games, canvases) that the accessibility tree
            // does not describe, so their evidence is the next screenshot, not a tree change.
            return new JSONObject()
                    .put("generation", before)
                    .put("evidence", "tap dispatched; no accessibility change");
        }
        if (!next.getBoolean("changed") && secureText) {
            // Password fields hide their text from the tree, so a successful set-text is the evidence.
            return new JSONObject()
                    .put("generation", before)
                    .put("evidence", "text set on a password field; tree unchanged by design");
        }
        if (!next.getBoolean("changed")) {
            throw new DriverError("verification-failed", "phone state did not change after action");
        }
        // Transitions emit several generations; return a settled one so the next step is not stale.
        JSONObject snapshot = next.getJSONObject("snapshot");
        long settleDeadline = SystemClock.elapsedRealtime() + ACTION_WAIT_MS;
        while (SystemClock.elapsedRealtime() < settleDeadline) {
            JSONObject later = waitForChange(snapshot.getString("generation"), SETTLE_QUIET_MS);
            if (!later.getBoolean("changed")) break;
            snapshot = later.getJSONObject("snapshot");
        }
        return new JSONObject()
                .put("generation", snapshot.getString("generation"))
                .put("evidence", "ui changed; foreground " + snapshot.optString("foregroundPackage", "unknown"));
    }

    private static boolean needsExactScreen(String type, JSONObject action) {
        if ("gesture.tap".equals(type)) return true;
        JSONObject target = action.optJSONObject("target");
        return target != null && target.has("elementId");
    }

    private TreeState capture() throws Exception {
        List<NodeRef> nodes = new ArrayList<>();
        ArrayDeque<NodeRef> queue = new ArrayDeque<>();
        String foreground = null;
        List<AccessibilityWindowInfo> windows = automation.getWindows();
        if (windows != null) {
            // Windows arrive top-down, so the first application window is the foreground app.
            for (AccessibilityWindowInfo window : windows) {
                AccessibilityNodeInfo root = window.getRoot();
                if (root == null) continue;
                if (foreground == null && window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION
                        && root.getPackageName() != null) {
                    foreground = root.getPackageName().toString();
                }
                queue.add(new NodeRef(root, -1));
            }
        }
        if (queue.isEmpty()) {
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root != null) queue.add(new NodeRef(root, -1));
        }

        while (!queue.isEmpty()) {
            if (nodes.size() >= Validators.MAX_NODES) {
                closeNodes(nodes);
                while (!queue.isEmpty()) queue.remove().node.recycle();
                throw new DriverError("snapshot-too-large", "UI tree exceeds " + Validators.MAX_NODES + " nodes");
            }
            NodeRef reference = queue.remove();
            reference.index = nodes.size();
            reference.json = describe(reference.node, reference.index);
            nodes.add(reference);
            if (foreground == null && reference.node.getPackageName() != null) {
                foreground = reference.node.getPackageName().toString();
            }
            for (int index = 0; index < reference.node.getChildCount(); index += 1) {
                AccessibilityNodeInfo child = reference.node.getChild(index);
                if (child != null) queue.add(new NodeRef(child, reference.index));
            }
        }

        for (NodeRef reference : nodes) inheritLabel(reference, nodes);
        JSONArray elements = new JSONArray();
        for (NodeRef reference : nodes) elements.put(reference.json);
        String fingerprint = sha256(elements.toString());
        synchronized (changeMonitor) {
            if (lastFingerprint != null && !lastFingerprint.equals(fingerprint)) sequence.incrementAndGet();
            lastFingerprint = fingerprint;
        }
        return new TreeState(generation(), foreground, elements, nodes);
    }

    private static JSONObject describe(AccessibilityNodeInfo node, int index) throws JSONException {
        JSONObject value = new JSONObject()
                .put("id", "node-" + index)
                .put("role", simpleName(node.getClassName()))
                .put("actionable", node.isClickable() || node.isLongClickable() || node.isEditable());
        if (node.isPassword()) value.put("password", true);
        else putText(value, "text", node.getText());
        putText(value, "description", node.getContentDescription());
        putText(value, "resourceId", node.getViewIdResourceName());
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (!bounds.isEmpty()) {
            value.put("bounds", new JSONObject()
                    .put("left", bounds.left)
                    .put("top", bounds.top)
                    .put("right", bounds.right)
                    .put("bottom", bounds.bottom));
        }
        return value;
    }

    private static void inheritLabel(NodeRef child, List<NodeRef> nodes) throws JSONException {
        if (!child.json.has("text") && !child.json.has("description")) return;
        int parentIndex = child.parentIndex;
        while (parentIndex >= 0) {
            NodeRef parent = nodes.get(parentIndex);
            if (parent.json.optBoolean("actionable")) {
                copyIfMissing(child.json, parent.json, "text");
                copyIfMissing(child.json, parent.json, "description");
                copyIfMissing(child.json, parent.json, "resourceId");
                return;
            }
            parentIndex = parent.parentIndex;
        }
    }

    private static AccessibilityNodeInfo resolve(TreeState state, JSONObject selector) throws Exception {
        List<NodeRef> matches = new ArrayList<>();
        List<NodeRef> actionable = new ArrayList<>();
        for (NodeRef reference : state.nodes) {
            if (!matches(reference.json, selector)) continue;
            matches.add(reference);
            if (reference.json.optBoolean("actionable")) actionable.add(reference);
        }
        List<NodeRef> candidates = actionable.isEmpty() ? matches : actionable;
        if (candidates.isEmpty()) throw new DriverError("target-not-found", "semantic target not found");
        if (candidates.size() > 1) throw new DriverError("ambiguous-selector", "semantic selector is ambiguous");
        return candidates.get(0).node;
    }

    private static boolean matches(JSONObject element, JSONObject selector) {
        if (selector.has("elementId")) return selector.optString("elementId").equals(element.optString("id"));
        if (selector.has("resourceId")) return selector.optString("resourceId").equals(element.optString("resourceId"));
        if (selector.has("description")) return selector.optString("description").equals(element.optString("description"));
        if (selector.has("text")) {
            return selector.optString("text").equals(element.optString("text"))
                    && (!selector.has("role") || selector.optString("role").equals(element.optString("role")));
        }
        return false;
    }

    private boolean tap(AccessibilityNodeInfo node, boolean longTap) {
        int action = longTap ? AccessibilityNodeInfo.ACTION_LONG_CLICK : AccessibilityNodeInfo.ACTION_CLICK;
        if (node.performAction(action)) return true;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return !bounds.isEmpty() && injectTap(bounds.centerX(), bounds.centerY(), longTap);
    }

    private static boolean setText(AccessibilityNodeInfo node, String value, boolean clear) {
        CharSequence current = node.getText();
        String text = clear || node.isPassword() || current == null ? value : current + value;
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
    }

    private boolean pressKey(String value) throws DriverError {
        int keyCode = switch (value) {
            case "back" -> KeyEvent.KEYCODE_BACK;
            case "home" -> KeyEvent.KEYCODE_HOME;
            case "recents" -> KeyEvent.KEYCODE_APP_SWITCH;
            case "enter" -> KeyEvent.KEYCODE_ENTER;
            case "delete" -> KeyEvent.KEYCODE_DEL;
            default -> throw new DriverError("invalid-request", "unsupported key");
        };
        long now = SystemClock.uptimeMillis();
        return automation.injectInputEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0), true)
                && automation.injectInputEvent(new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyCode, 0), true);
    }

    private boolean injectTap(int x, int y, boolean longTap) {
        long downAt = SystemClock.uptimeMillis();
        if (!injectMotion(downAt, downAt, MotionEvent.ACTION_DOWN, x, y)) return false;
        if (longTap) SystemClock.sleep(ViewConfiguration.getLongPressTimeout() + 100L);
        return injectMotion(downAt, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y);
    }

    private boolean swipe(JSONObject action) throws Exception {
        JSONObject from = requiredObject(action, "from");
        JSONObject to = requiredObject(action, "to");
        int fromX = requiredCoordinate(from, "x");
        int fromY = requiredCoordinate(from, "y");
        int toX = requiredCoordinate(to, "x");
        int toY = requiredCoordinate(to, "y");
        int duration = action.optInt("durationMs", -1);
        if (duration < 1 || duration > 10_000) throw new DriverError("invalid-request", "invalid swipe duration");
        long downAt = SystemClock.uptimeMillis();
        if (!injectMotion(downAt, downAt, MotionEvent.ACTION_DOWN, fromX, fromY)) return false;
        int frames = Math.max(1, duration / 16);
        for (int frame = 1; frame <= frames; frame += 1) {
            long target = downAt + ((long) duration * frame / frames);
            long remaining = target - SystemClock.uptimeMillis();
            if (remaining > 0) SystemClock.sleep(remaining);
            float progress = (float) frame / frames;
            if (!injectMotion(
                    downAt,
                    SystemClock.uptimeMillis(),
                    MotionEvent.ACTION_MOVE,
                    Math.round(fromX + (toX - fromX) * progress),
                    Math.round(fromY + (toY - fromY) * progress))) return false;
        }
        return injectMotion(downAt, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, toX, toY);
    }

    private boolean injectMotion(long downAt, long at, int action, float x, float y) {
        MotionEvent event = MotionEvent.obtain(downAt, at, action, x, y, 0);
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
            return automation.injectInputEvent(event, true);
        } finally {
            event.recycle();
        }
    }

    private boolean launch(String packageName) throws IOException {
        // Never monkey: its single "event" can be a random rotation that re-enables auto-rotate.
        ParcelFileDescriptor descriptor = automation.executeShellCommand(
                "am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p " + packageName);
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            byte[] buffer = new byte[4096];
            int total = 0;
            while (input.read(buffer) >= 0 && (total += buffer.length) < 65_536) {}
        }
        return true;
    }

    private void changed(AccessibilityEvent event) {
        // A new window always gets a new generation, even when it looks identical to an earlier one.
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) sequence.incrementAndGet();
        events.incrementAndGet();
        synchronized (changeMonitor) {
            changeMonitor.notifyAll();
        }
    }

    private String generation() {
        return sessionId + ":" + sequence.get();
    }

    private static JSONObject success(String id, JSONObject result) throws JSONException {
        return new JSONObject().put("id", id).put("ok", true).put("result", result);
    }

    private static JSONObject failure(String id, String code, String message) {
        try {
            return new JSONObject()
                    .put("id", id)
                    .put("ok", false)
                    .put("error", new JSONObject().put("code", code).put("message", message));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static void send(BufferedOutputStream output, JSONObject response) throws IOException {
        byte[] encoded = response.toString().getBytes(StandardCharsets.UTF_8);
        if (encoded.length > Validators.MAX_LINE_BYTES) {
            encoded = failure(response.optString("id", "unknown"), "response-too-large", "response exceeds protocol limit")
                    .toString()
                    .getBytes(StandardCharsets.UTF_8);
        }
        output.write(encoded);
        output.write('\n');
        output.flush();
    }

    // An oversized line cannot be resynchronized, so it ends the connection instead of replying.
    private static String readLine(BufferedInputStream input) throws IOException {
        ByteArrayOutputStream value = new ByteArrayOutputStream();
        while (true) {
            int next = input.read();
            if (next < 0) return value.size() == 0 ? null : new String(value.toByteArray(), StandardCharsets.UTF_8);
            if (next == '\n') break;
            if (value.size() >= Validators.MAX_LINE_BYTES) {
                throw new IOException("request exceeds protocol limit");
            }
            value.write(next);
        }
        byte[] bytes = value.toByteArray();
        int length = bytes.length > 0 && bytes[bytes.length - 1] == '\r' ? bytes.length - 1 : bytes.length;
        return new String(bytes, 0, length, StandardCharsets.UTF_8);
    }

    private static JSONObject requiredObject(JSONObject value, String name) throws DriverError {
        JSONObject result = value.optJSONObject(name);
        if (result == null) throw new DriverError("invalid-request", name + " must be an object");
        return result;
    }

    private static String requiredString(JSONObject value, String name, int maximum) throws DriverError {
        String result = value.optString(name, "");
        if (result.isEmpty() || result.length() > maximum) {
            throw new DriverError("invalid-request", name + " is invalid");
        }
        return result;
    }

    private static String requiredPackage(JSONObject value, String name) throws DriverError {
        String result = requiredString(value, name, 255);
        if (!result.matches("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+")) {
            throw new DriverError("invalid-request", "invalid package name");
        }
        return result;
    }

    private static int requiredCoordinate(JSONObject value, String name) throws DriverError {
        int result = value.optInt(name, -1);
        if (result < 0 || result > 100_000) throw new DriverError("invalid-request", "invalid coordinate");
        return result;
    }

    private static void putText(JSONObject value, String name, CharSequence raw) throws JSONException {
        if (raw == null || raw.length() == 0) return;
        String text = raw.length() > 2_000 ? raw.subSequence(0, 2_000).toString() : raw.toString();
        value.put(name, text);
    }

    private static void copyIfMissing(JSONObject from, JSONObject to, String name) throws JSONException {
        if (!to.has(name) && from.has(name)) to.put(name, from.get(name));
    }

    private static String simpleName(CharSequence value) {
        if (value == null) return "View";
        String name = value.toString();
        int separator = name.lastIndexOf('.');
        return separator < 0 ? name : name.substring(separator + 1);
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(digest.length * 2);
            for (byte item : digest) result.append(String.format("%02x", item));
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static boolean constantTimeEquals(String expected, String actual) {
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), actual.getBytes(StandardCharsets.UTF_8));
    }

    private static String newSessionId() {
        byte[] value = new byte[18];
        new SecureRandom().nextBytes(value);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return error.getClass().getSimpleName();
        return message.length() > 500 ? message.substring(0, 500) : message;
    }

    private static void close(Closeable value) {
        if (value == null) return;
        try {
            value.close();
        } catch (IOException ignored) {}
    }

    private static void closeNodes(List<NodeRef> nodes) {
        for (NodeRef reference : nodes) reference.node.recycle();
    }

    private static final class NodeRef {
        final AccessibilityNodeInfo node;
        final int parentIndex;
        int index;
        JSONObject json;

        NodeRef(AccessibilityNodeInfo node, int parentIndex) {
            this.node = node;
            this.parentIndex = parentIndex;
        }
    }

    private static final class TreeState implements AutoCloseable {
        final String generation;
        final String foregroundPackage;
        final JSONArray elements;
        final List<NodeRef> nodes;

        TreeState(String generation, String foregroundPackage, JSONArray elements, List<NodeRef> nodes) {
            this.generation = generation;
            this.foregroundPackage = foregroundPackage;
            this.elements = elements;
            this.nodes = nodes;
        }

        JSONObject toJson() throws JSONException {
            JSONObject result = new JSONObject()
                    .put("generation", generation)
                    .put("capturedAt", Instant.now().toString())
                    .put("elements", elements);
            if (foregroundPackage != null) result.put("foregroundPackage", foregroundPackage);
            return result;
        }

        @Override
        public void close() {
            closeNodes(nodes);
        }
    }

    private static final class DriverError extends Exception {
        final String code;

        DriverError(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
