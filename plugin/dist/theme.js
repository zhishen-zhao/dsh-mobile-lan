(() => {
  "use strict";
  const key = "dsh_mobile_theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  if (navigator.userAgent.includes("DSHMobileAndroid")) document.documentElement.classList.add("native-android");

  function storedPreference() {
    try {
      const value = localStorage.getItem(key);
      return ["system", "light", "dark"].includes(value) ? value : "system";
    } catch {
      return "system";
    }
  }

  function apply(preference) {
    const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = resolved;
  }

  function set(preference) {
    const normalized = ["system", "light", "dark"].includes(preference) ? preference : "system";
    try { localStorage.setItem(key, normalized); } catch {}
    apply(normalized);
    return normalized;
  }

  media.addEventListener("change", () => {
    if (storedPreference() === "system") apply("system");
  });
  apply(storedPreference());
  window.DSHTheme = { get: storedPreference, set };
})();
