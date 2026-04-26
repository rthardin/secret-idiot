self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: "The Undercurrent", body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "The Undercurrent", {
      body: data.body || "",
      icon: "/static/icon.png",
      badge: "/static/icon.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
