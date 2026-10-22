const [major, minor] = process.versions.node.split(".").map(Number);
const required = [22, 20];

if (major < required[0] || (major === required[0] && minor < required[1])) {
  console.error(
    `本项目需要 Node.js ${required[0]}.${required[1]} 或更高版本，当前是 Node.js ${process.versions.node}。请先切换 Node 版本，再运行 npm install 或 npm run dev。`,
  );
  process.exit(1);
}
