import { useEffect, useCallback, useState, useRef } from "react";
import { selectors } from "../config/selectors";

const MODERATION_TEXT = "Content Moderated. Try a different idea.";
const RATE_LIMIT_TEXT = "Rate limit reached";
const MODERATION_TRIGGER_COOLDOWN_MS = 5000; // hard guard between callbacks
const MODERATION_HOLD_MS = 2000; // keep detected state for stability

interface ModerationDetectorOptions {
	onModerationDetected: () => void;
	onRateLimitDetected?: () => void;
	enabled: boolean;
}

export const useModerationDetector = ({ onModerationDetected, onRateLimitDetected, enabled }: ModerationDetectorOptions) => {
	const [moderationDetected, setModerationDetected] = useState(false);
	const [rateLimitDetected, setRateLimitDetected] = useState(false);
	const [debounceTimeout, setDebounceTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
	const lastToastTextRef = useRef<string>("");
	const lastTriggerAtRef = useRef<number>(0);
	const lastModerationFingerprintRef = useRef<string>("");

	const diagLoggedRef = useRef(false);

	const checkForModeration = useCallback(() => {
		let isModerationDetected = false;
		let isRateLimitDetected = false;

		// Strategy 1: Check notifications section (aria-label*="Notifications")
		// Grok renders toasts inside <section aria-label="Notifications alt+T" aria-live="polite">
		const notificationsSection = document.querySelector(selectors.notifications.section);

		// One-time diagnostic log
		if (!diagLoggedRef.current) {
			diagLoggedRef.current = true;
			console.log("[Grok Retry] ModerationDetector diag", {
				selectorUsed: selectors.notifications.section,
				notifSectionFound: !!notificationsSection,
				notifSectionTag: notificationsSection?.tagName,
				notifSectionHTML: notificationsSection?.innerHTML?.substring(0, 200),
			});
		}

		if (notificationsSection) {
			// First try: specific toast element
			const latestToast = notificationsSection.querySelector<HTMLLIElement>('li.toast[data-visible="true"]');
			const textNode = latestToast?.querySelector<HTMLElement>("span, div");
			const toastText = textNode?.textContent ?? "";
			if (toastText && toastText !== lastToastTextRef.current) {
				lastToastTextRef.current = toastText;
			}
			if (toastText.includes(MODERATION_TEXT)) isModerationDetected = true;
			if (toastText.includes(RATE_LIMIT_TEXT)) isRateLimitDetected = true;

			// Second try: scan ALL text in the notifications section (toast structure may vary)
			if (!isModerationDetected) {
				const sectionText = notificationsSection.textContent ?? "";
				if (sectionText.includes(MODERATION_TEXT)) isModerationDetected = true;
				if (sectionText.includes(RATE_LIMIT_TEXT)) isRateLimitDetected = true;
			}

			// Log whenever notification section has non-empty content (toast appeared)
			const sectionText = notificationsSection.textContent?.trim() ?? "";
			if (sectionText.length > 0) {
				console.log("[Grok Retry] Notification section has content:", JSON.stringify(sectionText.substring(0, 200)));
			}
		}

		// Strategy 2: Scan full document body as fallback
		if (!isModerationDetected) {
			const bodyText = document.body?.textContent ?? "";
			isModerationDetected = bodyText.includes(MODERATION_TEXT);
			isRateLimitDetected = isRateLimitDetected || bodyText.includes(RATE_LIMIT_TEXT);
		}

		// Handle moderation detection
		if (isModerationDetected && !moderationDetected) {
			// Don't schedule a new timeout if one is already pending
			if (debounceTimeout) {
				return; // Already processing this moderation event
			}

			// Create a fingerprint for this moderation event to deduplicate
			const notificationsSection = document.querySelector(selectors.notifications.section);
			const latestToast = notificationsSection?.querySelector<HTMLLIElement>('li.toast[data-visible="true"]');
			const toastText = latestToast?.textContent?.trim() || "";
			const timestamp = Math.floor(Date.now() / 1000); // Round to nearest second
			const fingerprint = `${toastText}_${timestamp}`;

			// Only proceed if this is a new unique moderation event
			if (fingerprint === lastModerationFingerprintRef.current) {
				return; // Same event, ignore
			}
			lastModerationFingerprintRef.current = fingerprint;

			// Debounce the callback to prevent multiple rapid fires
			const timeout = setTimeout(() => {
				// Guard: prevent multiple triggers within cooldown window
				const now = Date.now();
				if (now - lastTriggerAtRef.current < MODERATION_TRIGGER_COOLDOWN_MS) {
					setDebounceTimeout(null);
					return;
				}
				lastTriggerAtRef.current = now;
				setModerationDetected(true);
				console.log("[Grok Retry] Moderation detected");
				try {
					(window as any).__grok_append_log?.("Moderation detected", "warn");
				} catch {}
				onModerationDetected();
				setDebounceTimeout(null);
			}, 100);

			setDebounceTimeout(timeout);
		} else if (!isModerationDetected && moderationDetected) {
			// Hold the detected state briefly to avoid oscillation on attribute churn
			const now = Date.now();
			if (now - lastTriggerAtRef.current >= MODERATION_HOLD_MS) {
				setModerationDetected(false);
			}
		}

		// Handle rate limit detection
		if (isRateLimitDetected && !rateLimitDetected) {
			if (debounceTimeout) {
				clearTimeout(debounceTimeout);
				setDebounceTimeout(null);
			}

			setRateLimitDetected(true);
			console.warn("[Grok Retry] Rate limit detected — cancelling active sessions");
			try {
				(window as any).__grok_append_log?.(
					"Rate limit detected — cancelling active sessions. Please wait before retrying.",
					"warn"
				);
			} catch {}
			onRateLimitDetected?.();
		} else if (!isRateLimitDetected && rateLimitDetected) {
			setRateLimitDetected(false);
		}

		return isModerationDetected || isRateLimitDetected;
	}, [moderationDetected, rateLimitDetected, onModerationDetected, onRateLimitDetected, debounceTimeout]);

	useEffect(() => {
		if (!enabled) return;

		// Initial check
		checkForModeration();

		// Observe the notifications section (where toasts appear) AND document.body as fallback
		const notifSection = document.querySelector(selectors.notifications.section);
		const targets: Node[] = [];
		if (notifSection) targets.push(notifSection);
		targets.push(document.body);

		const observer = new MutationObserver((mutations) => {
			if (mutations.some((m) => m.type === "childList")) {
				checkForModeration();
			}
		});

		for (const target of targets) {
			observer.observe(target, {
				childList: true,
				subtree: true,
			});
		}

		// Polling fallback: the MutationObserver target may not encompass
		// the actual notifications container, so poll as a safety net.
		const pollId = setInterval(checkForModeration, 1500);

		return () => {
			observer.disconnect();
			clearInterval(pollId);
			// Clear debounce timeout on cleanup
			if (debounceTimeout) {
				clearTimeout(debounceTimeout);
			}
		};
	}, [enabled, checkForModeration, debounceTimeout]);

	return { moderationDetected, rateLimitDetected, checkForModeration };
};
