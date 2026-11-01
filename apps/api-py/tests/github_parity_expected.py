"""Expected outputs of the TypeScript originals for the cases in tests/github_parity_cases.py (a string over
300 UTF-16 code units is {"sha256", "len"}; shorter is {"v"}). GENERATED -- do not edit by hand.

Regenerate (after changing a case, or the TypeScript originals in apps/api/src/github/submission-files.ts or
folder-path.ts on purpose) by running each case through `buildSubmissionFiles`/`buildPrBody`/`buildPrTitle`/
`buildCommitMessage`/`escapeMarkdown`/`oneLine`/`submissionFingerprint`/`slugify`/`normalizeFolder`/
`assertSafeRepoPath`/`JSON.stringify` with `npx tsx` from apps/api, mapping each result to the shape above.
"""

# ruff: noqa: E501

from __future__ import annotations

from typing import Any

EXPECTED: dict[str, Any] = {
    "slugify/plain": {"v": "order-flow"},
    "slugify/markdown": {"v": "everyone-x"},
    "slugify/accents": {"v": "cafe-resume"},
    "slugify/more-accents": {"v": "naive-facade-aao-n"},
    "slugify/decomposed": {"v": "cafe-resume"},
    "slugify/cjk": {"v": "diagram"},
    "slugify/blank": {"v": "diagram"},
    "slugify/dashes": {"v": "diagram"},
    "slugify/long-100": {"v": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    "slugify/long-words": {"v": "unicode-unicode-unicode-unicode-unicode-unicode-unicode-unic"},
    "slugify/emoji": {"v": "emoji-flow"},
    "slugify/emoji-only": {"v": "diagram"},
    "slugify/ligature": {"v": "fine-flow"},
    "slugify/fullwidth": {"v": "a123-test"},
    "slugify/roman": {"v": "viii-phase-i"},
    "slugify/dotted-i": {"v": "istanbul"},
    "slugify/sharp-s": {"v": "stra-e"},
    "slugify/trailing-dash-at-60": {"v": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"},
    "slugify/dash-run-at-60": {"v": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-zz"},
    "slugify/symbols": {"v": "a-b-c-d-e-f"},
    "slugify/nbsp": {"v": "a-b"},
    "slugify/superscript": {"v": "x2-y3"},
    "slugify/circled": {"v": "12-steps"},
    "slugify/angstrom": {"v": "a-ngstrom"},
    "slugify/turkish-dotless": {"v": "diagram"},
    "slugify/greek": {"v": "mega"},
    "slugify/mixed-case": {"v": "camelcasename-v2-0"},
    "slugify/empty": {"v": "diagram"},
    "normalize_folder/slashes": {"v": "architecture/diagrams"},
    "normalize_folder/backslashes": {"v": "architecture/diagrams/x"},
    "normalize_folder/spaces": {"v": "docs/x"},
    "normalize_folder/nbsp": {"v": "docs"},
    "normalize_folder/em-space": {"v": "docs"},
    "normalize_folder/bom": {"v": "docs"},
    "normalize_folder/mongolian-vowel-separator": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" '
        "only, and each part must start with a letter or number "
        '("\u180edocs").'
    },
    "normalize_folder/trailing-newline": {"v": "docs/x"},
    "normalize_folder/newline-inside": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" only, and each '
        'part must start with a letter or number ("a\n'
        '").'
    },
    "normalize_folder/next-line": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" only, and each part '
        'must start with a letter or number ("\x85'
        '").'
    },
    "normalize_folder/line-separator": {"v": "docs/x"},
    "normalize_folder/len-200": {
        "v": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    },
    "normalize_folder/len-201": {"error": "The folder is too long (at most 200 characters)."},
    "normalize_folder/emoji-100": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" only, and each part '
        "must start with a letter or number "
        '("😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀").'
    },
    "normalize_folder/emoji-101": {"error": "The folder is too long (at most 200 characters)."},
    "normalize_folder/depth-10": {"v": "a/a/a/a/a/a/a/a/a/a"},
    "normalize_folder/depth-11": {"error": "The folder is nested too deeply (at most 10 levels)."},
    "normalize_folder/reserved-upper": {"error": 'The folder can\'t use ".GIT".'},
    "normalize_folder/reserved-github": {"error": 'The folder can\'t use ".Github".'},
    "normalize_folder/reserved-canvas": {"error": 'The folder can\'t use ".CANVAS".'},
    "normalize_folder/gitignore": {"error": 'The folder can\'t use ".gitignore".'},
    "normalize_folder/dot-segment": {"error": 'The folder has an empty, "." or ".." part.'},
    "normalize_folder/dotdot": {"error": 'The folder has an empty, "." or ".." part.'},
    "normalize_folder/unicode-letters": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" only, and each '
        'part must start with a letter or number ("résumé").'
    },
    "normalize_folder/colon": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" only, and each part must '
        'start with a letter or number ("a:b").'
    },
    "normalize_folder/leading-dot": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" only, and each '
        'part must start with a letter or number (".hidden").'
    },
    "normalize_folder/dash-start": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" only, and each part '
        'must start with a letter or number ("-x").'
    },
    "normalize_folder/dot-inside": {"v": "a.b/c_d-e"},
    "normalize_folder/only-slashes": {
        "error": 'Choose a folder in the repository (for example "architecture/diagrams").'
    },
    "normalize_folder/only-backslashes": {
        "error": 'Choose a folder in the repository (for example "architecture/diagrams").'
    },
    "normalize_folder/tab": {"v": "docs"},
    "normalize_folder/empty": {"error": 'Choose a folder in the repository (for example "architecture/diagrams").'},
    "normalize_folder/emoji-in-folder": {
        "error": 'The folder may use letters, numbers, ".", "_" and "-" only, and each '
        'part must start with a letter or number ("a😀b").'
    },
    "assert_safe_repo_path/standard": {"v": ".canvas/standards/flowchart/v1.json"},
    "assert_safe_repo_path/validator": {"v": ".canvas/validator.mjs"},
    "assert_safe_repo_path/canvas-dotdot": {"error": 'The file path has an empty, "." or ".." part.'},
    "assert_safe_repo_path/canvas-reserved": {"error": 'The file path can\'t use ".git".'},
    "assert_safe_repo_path/plain": {"v": "a/b/order-flow.svg"},
    "assert_safe_repo_path/reserved": {"error": 'The file path can\'t use ".git".'},
    "assert_safe_repo_path/len-320": {
        "sha256": "402b584ecfd8409a8aa051b14f5bcc1e57aad1a666dfa482f1b53441808c0974",
        "len": 320,
    },
    "assert_safe_repo_path/len-321": {"error": "The file path is too long."},
    "assert_safe_repo_path/emoji-160": {
        "error": 'The file path may use letters, numbers, ".", "_" and "-" only, and '
        "each part must start with a letter or number "
        '("😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀").'
    },
    "assert_safe_repo_path/emoji-161": {"error": "The file path is too long."},
    "assert_safe_repo_path/canvas-long": {"error": "The file path is too long."},
    "assert_safe_repo_path/empty-segment": {"error": 'The file path has an empty, "." or ".." part.'},
    "assert_safe_repo_path/trailing-slash": {"error": 'The file path has an empty, "." or ".." part.'},
    "assert_safe_repo_path/canvas-bare": {"error": 'The file path can\'t use ".canvas".'},
    "assert_safe_repo_path/canvas-trailing": {"error": 'The file path has an empty, "." or ".." part.'},
    "assert_safe_repo_path/depth-after-canvas": {"v": ".canvas/a/a/a/a/a/a/a/a/a/a"},
    "assert_safe_repo_path/depth-after-canvas-11": {"error": "The file path is nested too deeply (at most 10 levels)."},
    "escape_markdown/mention-bold": {"v": "@\u200beveryone \\*\\*x\\*\\*"},
    "escape_markdown/newlines": {"v": "a b c"},
    "escape_markdown/specials": {"v": "\\`code\\` \\_u\\_ \\[l\\]\\(u\\) \\<b\\> \\# \\+ \\! \\| \\~ \\\\ \\{x\\}"},
    "escape_markdown/email": {"v": "x@\u200by.com @\u200b@\u200b"},
    "escape_markdown/tabs": {"v": "\t tabs \t"},
    "escape_markdown/emoji-mention": {"v": "emoji 😀 @\u200bhere"},
    "escape_markdown/backslash": {"v": "back\\\\slash \\\\\\\\"},
    "escape_markdown/line-separator": {"v": "a\u2028b\u2029c"},
    "escape_markdown/nbsp": {"v": "a\xa0b"},
    "escape_markdown/zero-width": {"v": "a\u200bb @\u200b"},
    "escape_markdown/dash-hyphen": {"v": "- a . b = c : d / e"},
    "escape_markdown/html-entity": {"v": "&amp; &lt;"},
    "escape_markdown/table": {"v": "\\| a \\| b \\|"},
    "escape_markdown/empty": {"v": ""},
    "one_line/tabs-newlines": {"v": "a b c d"},
    "one_line/long-130": {
        "v": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…"
    },
    "one_line/long-120": {
        "v": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    },
    "one_line/long-121": {
        "v": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…"
    },
    "one_line/emoji-70-of-100": {
        "v": "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…"
    },
    "one_line/emoji-50-of-100": {
        "v": "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"
    },
    "one_line/emoji-50-x-of-100": {
        "v": "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…"
    },
    "one_line/emoji-odd-offset": {
        "v": "x😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀…"
    },
    "one_line/emoji-80": {"v": "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…"},
    "one_line/unicode-spaces": {"v": "a b c"},
    "one_line/mongolian": {"v": "a\u180eb"},
    "one_line/bom": {"v": "bom"},
    "one_line/next-line": {"v": "x\x85y"},
    "one_line/padding": {"v": "lead trail"},
    "one_line/only-spaces": {"v": ""},
    "one_line/accents": {"v": "ééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééé…"},
    "one_line/line-separator": {"v": "a b"},
    "one_line/vertical-tab": {"v": "a b c"},
    "fingerprint/plain": {"v": "8d7fccea7b04b02fb50d9b0f4ce20e23f3df499abebc779efda54021f997ff09"},
    "fingerprint/no-description": {"v": "c897dcb3f1056d214b0c4158e13e74fb74f6adf0c383b6535751f9f4b71b71ec"},
    "fingerprint/empty-description": {"v": "916d584b37223d246fa5eff7fa70054fd742b8fe9b067a9ce1f5c0f08833336c"},
    "fingerprint/unicode": {"v": "78c9a6d83d8c95303c71c27c64c893a64d98753d086f8cc8d9c1a29250cec00c"},
    "fingerprint/control": {"v": "ceda3d6cea626af08d2d0bbe0bcfc27a2365445b12d50ab3c9902e45fa136e29"},
    "fingerprint/lone-surrogate": {"v": "c4a71574af2c9f8d6bdd26c6a957c2cd2f95a9d9b71ee1687e8b88395cd21c23"},
    "fingerprint/lone-low-surrogate": {"v": "f6b28c94a68659d92044d3ea05f2368de3c4d616f57c3b96b21dc66960ee9a7b"},
    "stringify/integer-valued-float": {"v": '{\n  "minCount": 2,\n  "maxCount": 10\n}'},
    "stringify/fractions": {"v": '{\n  "a": 1.5,\n  "b": 0.1,\n  "c": -2.25,\n  "d": 100.125\n}'},
    "stringify/negative-zero": {"v": '{\n  "z": 0\n}'},
    "stringify/tiny": {"v": '{\n  "a": 0.00001,\n  "b": 1e-7,\n  "c": 0.000001,\n  "d": 1.5e-9\n}'},
    "stringify/huge": {
        "v": '{\n  "a": 1e+21,\n  "b": 1.5e+300,\n  "c": 123456789012345680000,\n  "d": 100000000000000000000\n}'
    },
    "stringify/nested": {
        "v": "{\n"
        '  "x": [\n'
        "    1,\n"
        "    [\n"
        "      2,\n"
        "      {\n"
        '        "y": 3\n'
        "      }\n"
        "    ]\n"
        "  ],\n"
        '  "z": null,\n'
        '  "t": true,\n'
        '  "f": false\n'
        "}"
    },
    "stringify/long-fraction": {"v": '{\n  "a": 0.30000000000000004,\n  "b": 0.3333333333333333,\n  "c": 5e-324\n}'},
    "stringify/big-integers": {
        "v": '{\n  "a": 9007199254740992,\n  "b": 12345678901234567000,\n  "c": 9007199254740992\n}'
    },
    "stringify/integer-keys": {"v": '{\n  "1": 6,\n  "2": 3,\n  "10": 2,\n  "b": 1,\n  "a": 4,\n  "01": 5\n}'},
    "stringify/empty-containers": {"v": '{\n  "a": [],\n  "b": {},\n  "c": [\n    [],\n    {}\n  ]\n}'},
    "stringify/string-escapes": {
        "v": '{\n  "q": "a\\"b\\\\c",\n  "n": "l1\\nl2\\tx\\r",\n  "c": "\\u0001\\u001f\x7f\u2028",\n  "e": "😀"\n}'
    },
    "stringify/compact": {"v": '{"x":[1,[2,{"y":3}]],"z":null,"t":true,"f":false}'},
    "files/typical": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "67f689eadf4182e8c0eca1ab67ab199e6e9af92bec8de4cc3893ad86a4f69390", "len": 661},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "68a4acd2b80d2762c0ada0e9942d945a5fc790ae81f05106c0c480f309277fe7", "len": 647},
        },
        {
            "path": ".canvas/standards/flowchart/v2.json",
            "content": {"sha256": "1a32e5c32269c84e55603fed683866ebe7ef3b597c2b8e71237506742bfbf404", "len": 696},
        },
    ],
    "files/no-standard": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "f9f2e44e16003131122c10236083253d03359f51559f850d41c10e5fe23cb390", "len": 634},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/standard-nulls": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "45ccc911e841b0b412c479893cdaa331a6c9e00a4df8040cec2a45d866f53cf2", "len": 650},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "bc8ab188d548cdd9ee009b9299adead67f64c99b00671cfec5065ee6b6a6c4be", "len": 630},
        },
        {
            "path": ".canvas/standards/flowchart/v2.json",
            "content": {
                "v": "{\n"
                '  "id": "7f1e2d3c-0000-4000-8000-000000000001",\n'
                '  "diagramTypeId": "flowchart",\n'
                '  "version": 2,\n'
                '  "name": null,\n'
                '  "description": null,\n'
                '  "rules": null\n'
                "}\n"
            },
        },
    ],
    "files/standard-empty-rules": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "67f689eadf4182e8c0eca1ab67ab199e6e9af92bec8de4cc3893ad86a4f69390", "len": 661},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "68a4acd2b80d2762c0ada0e9942d945a5fc790ae81f05106c0c480f309277fe7", "len": 647},
        },
        {
            "path": ".canvas/standards/flowchart/v2.json",
            "content": {
                "v": "{\n"
                '  "id": "7f1e2d3c-0000-4000-8000-000000000001",\n'
                '  "diagramTypeId": "flowchart",\n'
                '  "version": 2,\n'
                '  "name": "Order process rules",\n'
                '  "description": "Steps for order flows.",\n'
                '  "rules": {}\n'
                "}\n"
            },
        },
    ],
    "files/validator": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "f9f2e44e16003131122c10236083253d03359f51559f850d41c10e5fe23cb390", "len": 634},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
        {"path": ".canvas/validator.mjs", "content": {"v": "// validator v1\nexport {};\n"}},
    ],
    "files/empty-validator": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "f9f2e44e16003131122c10236083253d03359f51559f850d41c10e5fe23cb390", "len": 634},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/description-markdown": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "46e6c67563feaf784419b1172f6aae8a9012b0801c278abcd6aab5d58a03ff2f", "len": 700},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "68a4acd2b80d2762c0ada0e9942d945a5fc790ae81f05106c0c480f309277fe7", "len": 647},
        },
        {
            "path": ".canvas/standards/flowchart/v2.json",
            "content": {"sha256": "1a32e5c32269c84e55603fed683866ebe7ef3b597c2b8e71237506742bfbf404", "len": 696},
        },
    ],
    "files/description-whitespace": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "67f689eadf4182e8c0eca1ab67ab199e6e9af92bec8de4cc3893ad86a4f69390", "len": 661},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "68a4acd2b80d2762c0ada0e9942d945a5fc790ae81f05106c0c480f309277fe7", "len": 647},
        },
        {
            "path": ".canvas/standards/flowchart/v2.json",
            "content": {"sha256": "1a32e5c32269c84e55603fed683866ebe7ef3b597c2b8e71237506742bfbf404", "len": 696},
        },
    ],
    "files/description-long": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "a2286c9eca622aaea923abf59a2a296fad80094d9298eaffc156e923c33439b2", "len": 1389},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/hostile-name": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "e74a154d0184620a174a42963750b4a40c466a04f55387d8baa6408e4b121460", "len": 898},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "49fe18f69722978646e42e66fa2e273d254968bbebf340917e55c14cf8bf6bd5", "len": 555},
        },
    ],
    "files/emoji-name": [
        {
            "path": "docs/diagram/README.md",
            "content": {"sha256": "58df2514a1c5fc49a82ae0613a5c343a47ae5ab6ee5d98224bfce631c6c5a130", "len": 841},
        },
        {
            "path": "docs/diagram/diagram.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {"path": "docs/diagram/diagram.mmd", "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"}},
        {
            "path": "docs/diagram/diagram.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "docs/diagram/canvas.json",
            "content": {"sha256": "fe3d7a6a49a840b1cf7877def88c1f861056aa048b2d646585cf020c9079183b", "len": 554},
        },
    ],
    "files/fence-triple": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "5c37e0972e6a88ac0e1d66f2ddcc2e04536c4f2aa3d0198995e8e8d5b7bc6223", "len": 618},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {"path": "architecture/order-flow/order-flow.mmd", "content": {"v": "flowchart TD\n  A[```x```] --> B\n"}},
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/fence-quad": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "66609653861e6dbebeeae246880e5219a73c15471396b0bfcbd7fee54461c2b3", "len": 605},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {"path": "architecture/order-flow/order-flow.mmd", "content": {"v": "x\n````\nfence\n```\n"}},
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/fence-single": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "3f31809ba51bd6cceb87735f56d73a2e1517d30dac5c3e5f1643cfb18503fc7f", "len": 605},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {"path": "architecture/order-flow/order-flow.mmd", "content": {"v": "A[`code`] --> B[` `]"}},
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/trailing-space": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "61ee6081550bb2c8d9f0807384f3179c1610a1a36124e9755439c43b4fd8c547", "len": 607},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {"path": "architecture/order-flow/order-flow.mmd", "content": {"v": "flowchart TD\n  A --> B\n\n  \n"}},
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/trailing-unicode-space": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "61ee6081550bb2c8d9f0807384f3179c1610a1a36124e9755439c43b4fd8c547", "len": 607},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A --> B\xa0\u2003\ufeff\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/empty-mermaid": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "92dc8ee38f58c5105a1752ba7de556ac494e2f77e07c235b73b96eb1a3d14459", "len": 585},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {"path": "architecture/order-flow/order-flow.mmd", "content": {"v": ""}},
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "2547b878b08fc725eb6113271972fd49c8256103742ac2649406474f71dd60e6", "len": 493},
        },
    ],
    "files/canvas-url-special": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "aec5b762d7d2260ee65c9d7cc16bddd619eac99a66b70cca9d3ee7608d36b044", "len": 612},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" '
                'height="100%" fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "e7be5f621a044236fc02da1e0a8f5db7303d957bd8349eb1ffa144f59d31eb94", "len": 471},
        },
    ],
    "files/deep-path": {"error": "The file path is nested too deeply (at most 10 levels)."},
    "files/version-large": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "1435fa18ad3374cac359fd84013b4e28f26b21883a8c7486ed2c49bf9c28a2ca", "len": 640},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {
                "v": "---\n"
                "canvas:\n"
                "  positions:\n"
                "    A:\n"
                "      x: 40\n"
                "      y: 40\n"
                "---\n"
                "flowchart TD\n"
                "  A[Receive order] --> B[Ship order]\n"
            },
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "be0308bea11eb518c792612aec2d3c46e602fef3527e06fd9acb2dd08c5283ea", "len": 499},
        },
    ],
    "files/crlf-source": [
        {
            "path": "architecture/order-flow/README.md",
            "content": {"sha256": "f9f2e44e16003131122c10236083253d03359f51559f850d41c10e5fe23cb390", "len": 634},
        },
        {
            "path": "architecture/order-flow/order-flow.svg",
            "content": {
                "v": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" '
                'fill="#ffffff" /></svg>\n'
            },
        },
        {
            "path": "architecture/order-flow/order-flow.mmd",
            "content": {"v": "flowchart TD\n  A[Receive order] --> B[Ship order]\n"},
        },
        {
            "path": "architecture/order-flow/order-flow.canvas.mmd",
            "content": {"v": "---\r\ncanvas: {}\r\n---\r\nflowchart TD\r\n  A --> B\r\n"},
        },
        {
            "path": "architecture/order-flow/canvas.json",
            "content": {"sha256": "61b91ca6b99aeb9ae552c3b6f9aa2fc37ec781f65b333a12918d7916f7725e80", "len": 493},
        },
    ],
    "files/unsafe-slug": {"error": 'The file path has an empty, "." or ".." part.'},
    "files/unsafe-path": {"error": 'The file path can\'t use ".git".'},
    "files/unsafe-type": {"error": 'The file path has an empty, "." or ".." part.'},
    "pr_title/plain": {"v": "Canvas: Order Flow (version 7)"},
    "pr_title/len-100": {
        "v": "Canvas: "
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "
        "(version 7)"
    },
    "pr_title/len-101": {
        "v": "Canvas: "
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa… "
        "(version 7)"
    },
    "pr_title/emoji-60": {
        "v": "Canvas: 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d… (version 7)"
    },
    "pr_title/emoji-50": {
        "v": "Canvas: 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀 (version 7)"
    },
    "pr_title/emoji-odd": {
        "v": "Canvas: x😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀… (version 7)"
    },
    "pr_title/whitespace": {"v": "Canvas: a b c d (version 7)"},
    "pr_title/markdown": {"v": "Canvas: @everyone **x** `y` (version 7)"},
    "pr_title/blank": {"v": "Canvas:  (version 7)"},
    "commit/plain/False": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/plain/True": {
        "v": 'Update "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/len-100/False": {
        "v": "Submit "
        '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…" '
        "(version 4) from Canvas\n"
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/len-100/True": {
        "v": "Update "
        '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…" '
        "(version 4) from Canvas\n"
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/len-101/False": {
        "v": "Submit "
        '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…" '
        "(version 4) from Canvas\n"
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/len-101/True": {
        "v": "Update "
        '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…" '
        "(version 4) from Canvas\n"
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-60/False": {
        "v": 'Submit "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-60/True": {
        "v": 'Update "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-50/False": {
        "v": 'Submit "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-50/True": {
        "v": 'Update "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-odd/False": {
        "v": 'Submit "x😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀…" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-odd/True": {
        "v": 'Update "x😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀…" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/whitespace/False": {
        "v": 'Submit "a b c d" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/whitespace/True": {
        "v": 'Update "a b c d" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/markdown/False": {
        "v": 'Submit "@everyone **x** `y`" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/markdown/True": {
        "v": 'Update "@everyone **x** `y`" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/blank/False": {
        "v": 'Submit "" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/blank/True": {
        "v": 'Update "" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/len-80/False": {
        "v": "Submit "
        '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" '
        "(version 4) from Canvas\n"
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/len-80/True": {
        "v": "Update "
        '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" '
        "(version 4) from Canvas\n"
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/len-81/False": {
        "v": "Submit "
        '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb…" '
        "(version 4) from Canvas\n"
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/len-81/True": {
        "v": "Update "
        '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb…" '
        "(version 4) from Canvas\n"
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-41/False": {
        "v": 'Submit "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-41/True": {
        "v": 'Update "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d…" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-40/False": {
        "v": 'Submit "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit/emoji-40/True": {
        "v": 'Update "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/?diagramId=abc\n"
        "\n"
        "Co-authored-by: Olivia Owner <o@x.test>\n"
    },
    "commit_author/brackets": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: Olivia Owner <owner@example.com>\n"
    },
    "commit_author/only-brackets": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: owner@example.com <owner@example.com>\n"
    },
    "commit_author/blank": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: owner@example.com <owner@example.com>\n"
    },
    "commit_author/empty": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: owner@example.com <owner@example.com>\n"
    },
    "commit_author/email-spaces": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: Olivia <ow@ner@example.com>\n"
    },
    "commit_author/email-unicode-space": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: Olivia <own@x.test>\n"
    },
    "commit_author/long-name": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: "
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx… "
        "<a@b.test>\n"
    },
    "commit_author/emoji-name": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\ud83d… "
        "<a@b.test>\n"
    },
    "commit_author/emoji-name-odd": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: y😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀… "
        "<a@b.test>\n"
    },
    "commit_author/newline-name": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: Eve Second Line <a@b.test>\n"
    },
    "commit_author/mention-name": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: @octocat <a@b.test>\n"
    },
    "commit_author/tab-name": {
        "v": 'Submit "Order Flow" (version 4) from Canvas\n'
        "\n"
        "Canvas: http://canvas.test/\n"
        "\n"
        "Co-authored-by: a b <a@b.test>\n"
    },
    "body/plain": {"sha256": "a3aa0ae8ffd4a5d42ce12a28daf00f5750d5d3a56569028cdb14814d7daba44a", "len": 606},
    "body/standard": {"sha256": "c4e60b0a530248d5ad8f7b30263d2090e6e1abbff064a0acfd3f97d24aa76c68", "len": 623},
    "body/standard-null-name": {
        "sha256": "80e369ba131d4f4dab0d24cf84f7e76d12b32f82f0fc36d6f923c83fd4130872",
        "len": 612,
    },
    "body/few-warnings": {"sha256": "9cf87a5f37ef7a2b39bb7e68a378144fd88aa50573366f3b117595a21a94b89c", "len": 775},
    "body/sixty-warnings": {"sha256": "e19ebdeb662eaa46fb61ef886ba847db257cc06d2c1fc41518f0edb152b7f511", "len": 2311},
    "body/documents": {"sha256": "2fd7d58817236d77a3703860bddae99ea350ba62dcd3e0ed8fe3dab22c603ecd", "len": 1065},
    "body/many-documents": {"sha256": "32ffe93fcf9e70c90c933d6b69874f407ad30427e20a746edfb0055ad11392c1", "len": 2564},
    "body/warnings-and-documents": {
        "sha256": "3bcc98bc83f7fb8bb518490e84e2f7c347a326b1258e635cb814b876370d1ad5",
        "len": 1217,
    },
    "body/hostile": {"sha256": "a849e83406c546fa076b4a13704aff4e6447d782398aaf3541a197a2fb165f74", "len": 563},
    "body/path-encoding": {"sha256": "f893e55943165e20be1779d5e02df1d6c4e754e0e3a8821db10673dab2eb7d46", "len": 595},
    "body/truncated-emoji-even": {
        "sha256": "d9ce04df401cab21bee8688bc9d3f7bca405f3ea21a7023862e6776dbd27633c",
        "len": 59996,
    },
    "body/truncated-emoji-odd": {
        "sha256": "f3b526dc961e74ece6cf529d86b236ad5c8088e8fee0ca791a6fd95961b4cef5",
        "len": 59996,
    },
    "body/truncated-name-0": {
        "sha256": "779f6ff6b78f985f39f8b1d7ec1728665b90035c2b1e2e40f53ae804c3acf9b5",
        "len": 59996,
    },
    "body/truncated-name-1": {
        "sha256": "97b304daa6a36ce4839d8c9784609b266a446cf03ec30d8aa590b11def94c3c6",
        "len": 59996,
    },
    "body/truncated-name-2": {
        "sha256": "7c914b86bfbb29890af7b34ae5eae161e7440136b81850d528e2cb269b8ede07",
        "len": 59996,
    },
    "body/truncated-name-3": {
        "sha256": "e741d6f382c20879e486bfd0e20a630c75a78f4b78d65dac4d9bd5e05fb46851",
        "len": 59996,
    },
    "body/exactly-near-limit": {
        "sha256": "e1ebd1931b9a4dbb2259c8a419b80a20e7d838a21b64dd466fbf6c6d84cf3828",
        "len": 59996,
    },
    "body/long-ascii": {"sha256": "5f7cc0fcb6db488be436c51d209bb4b4dad92f883e076232de130cdfb786fe0b", "len": 59996},
}
