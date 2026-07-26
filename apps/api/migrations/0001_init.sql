-- Base schema for the Governed Multi-Persona Diagramming Platform.
-- See specs/001-diagramming-platform/data-model.md for the entity model this implements.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'architect', 'viewer')),
  personas TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_project_id UUID REFERENCES projects (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE diagram_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  personas TEXT[] NOT NULL,
  abstraction_level TEXT NOT NULL,
  dsl_family TEXT NOT NULL,
  default_palette_library_ids TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE icon_libraries (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  license TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE TABLE icons (
  library_id TEXT NOT NULL,
  library_version TEXT NOT NULL,
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  category TEXT NOT NULL,
  asset_ref TEXT NOT NULL,
  PRIMARY KEY (library_id, library_version, id),
  FOREIGN KEY (library_id, library_version) REFERENCES icon_libraries (id, version) ON DELETE CASCADE
);

CREATE TABLE standards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  allowed_shape_ids TEXT[] NOT NULL DEFAULT '{}',
  mandatory_shape_ids TEXT[] NOT NULL DEFAULT '{}',
  allowed_icon_library_refs JSONB NOT NULL DEFAULT '[]',
  color_palette JSONB NOT NULL DEFAULT '[]',
  font_constraints JSONB,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (diagram_type_id, version)
);

-- Only one published Standard per diagram type at a time (FR-014, data-model.md).
CREATE UNIQUE INDEX standards_one_published_per_type
  ON standards (diagram_type_id)
  WHERE status = 'published';

CREATE TABLE diagrams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id),
  project_id UUID NOT NULL REFERENCES projects (id),
  owner_id UUID NOT NULL REFERENCES users (id),
  current_version_id UUID, -- FK added after diagram_versions exists; see below
  standard_version_at_last_check INTEGER,
  last_validation_result JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE diagram_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id UUID NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  dsl_content TEXT NOT NULL,
  author_id UUID NOT NULL REFERENCES users (id),
  violations_at_save JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (diagram_id, sequence_number)
);

ALTER TABLE diagrams
  ADD CONSTRAINT diagrams_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES diagram_versions (id);

CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id),
  persona TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  seed_dsl_content TEXT NOT NULL
);

CREATE TABLE share_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('diagram', 'project')),
  subject_id UUID NOT NULL,
  grantee_user_id UUID NOT NULL REFERENCES users (id),
  access_level TEXT NOT NULL CHECK (access_level IN ('view', 'comment', 'edit')),
  granted_by_user_id UUID NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, grantee_user_id)
);

CREATE INDEX diagrams_project_id_idx ON diagrams (project_id);
CREATE INDEX diagrams_name_idx ON diagrams (name);
CREATE INDEX share_grants_subject_idx ON share_grants (subject_type, subject_id);
