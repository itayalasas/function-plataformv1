import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileCode, Folder, FolderOpen, Trash2 } from "lucide-react";

export type FileTreeEntry = {
  id: string;
  path: string;
  content: string;
  updated_at: string;
  kind: "file" | "dir";
};

type TreeNode = {
  path: string;
  name: string;
  kind: "file" | "dir";
  explicit: boolean;
  id?: string;
  content?: string;
  updated_at?: string;
  children: TreeNode[];
};

interface FileTreeProps {
  items: FileTreeEntry[];
  activePath: string;
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  onSelectNode: (path: string, kind: "file" | "dir") => void;
  onDeletePath: (path: string, kind: "file" | "dir") => void;
}

function buildTree(items: FileTreeEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];

  const ensureChild = (
    siblings: TreeNode[],
    path: string,
    name: string,
    kind: "file" | "dir",
  ): TreeNode => {
    let node = siblings.find((child) => child.path === path);
    if (!node) {
      node = {
        path,
        name,
        kind,
        explicit: false,
        children: [],
      };
      siblings.push(node);
      return node;
    }

    if (kind === "file") node.kind = "file";
    return node;
  };

  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));
  for (const item of sorted) {
    const parts = item.path.split("/").filter(Boolean);
    if (!parts.length) continue;

    let siblings = roots;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = i === parts.length - 1;
      const nodeKind = isLeaf ? item.kind : "dir";
      const node = ensureChild(siblings, currentPath, part, nodeKind);
      if (isLeaf) {
        node.explicit = true;
        node.kind = item.kind;
        node.id = item.id;
        node.content = item.content;
        node.updated_at = item.updated_at;
      } else {
        node.kind = "dir";
      }
      siblings = node.children;
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

function TreeRow({
  node,
  depth,
  activePath,
  selectedPath,
  collapsed,
  onToggle,
  onOpenFile,
  onSelectNode,
  onDeletePath,
}: {
  node: TreeNode;
  depth: number;
  activePath: string;
  selectedPath?: string | null;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelectNode: (path: string, kind: "file" | "dir") => void;
  onDeletePath: (path: string, kind: "file" | "dir") => void;
}) {
  const isDir = node.kind === "dir";
  const isOpen = !collapsed[node.path];
  const indent = { paddingLeft: `${depth * 14 + 8}px` };
  const isHighlighted = activePath === node.path || selectedPath === node.path;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 px-2 py-1 rounded text-sm ${
          isHighlighted
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-secondary/50"
        }`}
        style={indent}
      >
        {isDir ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title={isOpen ? "Contraer carpeta" : "Expandir carpeta"}
          >
            {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        ) : (
          <span className="w-3 h-3 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => {
            onSelectNode(node.path, node.kind);
            if (isDir) onToggle(node.path);
            else onOpenFile(node.path);
          }}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={node.path}
        >
          {isDir ? (
            isOpen ? (
              <FolderOpen className="w-3 h-3 shrink-0" />
            ) : (
              <Folder className="w-3 h-3 shrink-0" />
            )
          ) : (
            <FileCode className="w-3 h-3 shrink-0" />
          )}
          <span className="truncate font-mono text-xs">{node.name}</span>
        </button>

        <button
          type="button"
          className="shrink-0 rounded p-1 text-destructive/80 opacity-80 transition hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onDeletePath(node.path, node.kind)}
          title={isDir ? "Borrar carpeta" : "Borrar archivo"}
          aria-label={isDir ? `Borrar carpeta ${node.path}` : `Borrar archivo ${node.path}`}
        >
          <Trash2 className="w-3 h-3 text-destructive" />
        </button>
      </div>

      {isDir && isOpen && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              selectedPath={selectedPath}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onSelectNode={onSelectNode}
              onDeletePath={onDeletePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  items,
  activePath,
  selectedPath,
  onOpenFile,
  onSelectNode,
  onDeletePath,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(items), [items]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <div className="p-1">
      {tree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          selectedPath={selectedPath}
          collapsed={collapsed}
          onToggle={(path) => setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))}
          onOpenFile={onOpenFile}
          onSelectNode={onSelectNode}
          onDeletePath={onDeletePath}
        />
      ))}
    </div>
  );
}
