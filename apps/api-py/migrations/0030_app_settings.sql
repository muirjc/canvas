-- canvas-8em: platform-wide feature switches an admin can flip without a redeploy. Singleton row,
-- like ai_settings (the id CHECK makes a second row impossible). sharing_enabled shows the editor's
-- Share button; off by default. Sharing itself (grants, the API, "Shared with me") keeps working
-- either way -- only the button is hidden.
CREATE TABLE app_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  sharing_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id, sharing_enabled) VALUES (true, false);
