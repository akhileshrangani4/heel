-- Roadmap 1.6: agent tokens expire. Static tokens issued before this never
-- did; they get 90 days from the upgrade, the default for new tokens, so no
-- agent stops working the moment heel is upgraded. A token issued later with
-- --expires never keeps a null expiry: this runs once.
UPDATE `agent_tokens`
SET `expires_at` = (CAST(strftime('%s', 'now') AS INTEGER) * 1000) + 7776000000
WHERE `kind` = 'static' AND `expires_at` IS NULL AND `revoked_at` IS NULL;
