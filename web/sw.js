"use strict";

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { title: "검토함", body: event.data ? event.data.text() : "" };
	}
	const title = data.title || "검토함";
	event.waitUntil(
		self.registration.showNotification(title, {
			body: data.body || "",
			tag: data.tag || undefined,
			renotify: Boolean(data.tag),
			data: { url: data.url || "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL((event.notification.data && event.notification.data.url) || "/", self.registration.scope);
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const client of windows) {
				const open = new URL(client.url);
				if (open.origin === target.origin && open.pathname === target.pathname && open.search === target.search) {
					await client.focus();
					return;
				}
			}
			await self.clients.openWindow(target.href);
		})(),
	);
});
