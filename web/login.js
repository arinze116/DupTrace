const form = document.getElementById("loginForm");
const input = document.getElementById("password");
const button = document.getElementById("submit");
const error = document.getElementById("error");
form.addEventListener("submit", async (event) => {
  event.preventDefault(); error.textContent = ""; button.disabled = true;
  try {
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ password: input.value }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(result.error || "Unable to sign in.");
    window.location.replace("/");
  } catch (err) { error.textContent = err.message || "Unable to sign in."; input.select(); }
  finally { button.disabled = false; }
});
