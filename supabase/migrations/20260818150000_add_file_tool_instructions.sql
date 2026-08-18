-- Give every agent explicit instructions for the real built-in file tool.
INSERT INTO skills (id, name, description, tier, category, instructions, status)
VALUES (
  'file_creation',
  'File Creation & Editing',
  'Creates, reads, lists, and edits files through Agentie''s real files tool.',
  'core',
  'productivity',
  'When the user asks you to create, read, view, list, or edit a file, use the built-in files plugin. Available actions: create_file with {name, content}; read_file with {fileId} or {name}; list_files; edit_file with {fileId or name, content, optional name}. Supported generated formats include txt, md, json, csv, html, docx, xlsx, and pdf. For docx/xlsx/pdf edits, regenerate the complete file with create_file/edit_file rather than pretending to modify binary bytes directly. After a successful file action, tell the user what was created or changed and include the returned file metadata. Never claim a file was created, viewed, or edited unless the files tool returned success.',
  'active'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  tier = EXCLUDED.tier,
  category = EXCLUDED.category,
  instructions = EXCLUDED.instructions,
  status = EXCLUDED.status;
