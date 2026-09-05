export type Target = {
  key: string;
  profile: number;
  server: number;
  binding: number;
  name: string;
  host: string;
  port: number;
  protocol: 'TCP' | 'UDP';
};
export type MieruConfig = {
  profiles: Array<Record<string, any>>;
  activeProfile: string;
  [key: string]: any;
};
export function parseConfig(text: string): {
  config: MieruConfig;
  targets: Target[];
} {
  if (new TextEncoder().encode(text).length > 131072)
    throw new Error('配置文件不能超过 128 KB');
  let config: MieruConfig;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('这不是有效的 JSON 配置文件');
  }
  if (
    !config ||
    !Array.isArray(config.profiles) ||
    config.profiles.length > 32 ||
    typeof config.activeProfile !== 'string'
  )
    throw new Error('请上传含 profiles 和 activeProfile 的 Mieru 客户端 JSON');
  const targets: Target[] = [];
  config.profiles.forEach((p, pi) => {
    if (
      !p ||
      typeof p.profileName !== 'string' ||
      !p.user ||
      typeof p.user.name !== 'string' ||
      !(
        typeof p.user.password === 'string' ||
        typeof p.user.hashedPassword === 'string'
      ) ||
      !Array.isArray(p.servers)
    )
      throw new Error('配置缺少有效的节点账号或 servers');
    p.servers.forEach((s: any, si: number) => {
      if (!s || !Array.isArray(s.portBindings))
        throw new Error('配置缺少 portBindings');
      s.portBindings.forEach((b: any, bi: number) => {
        if (b.portRange)
          throw new Error('首版支持单端口配置，请导出单端口配置后上传');
        const host = s.domainName || s.ipAddress;
        if (
          typeof host !== 'string' ||
          !host ||
          !Number.isInteger(b.port) ||
          b.port < 1 ||
          b.port > 65535 ||
          !['TCP', 'UDP'].includes(b.protocol)
        )
          throw new Error('节点地址、端口或协议无效');
        targets.push({
          key: `${pi}:${si}:${bi}`,
          profile: pi,
          server: si,
          binding: bi,
          name: p.profileName,
          host,
          port: b.port,
          protocol: b.protocol,
        });
      });
    });
  });
  if (
    !targets.length ||
    targets.length > 64 ||
    !config.profiles.some((p) => p.profileName === config.activeProfile)
  )
    throw new Error('没有可识别的有效节点');
  return { config, targets };
}
export function rewriteConfig(
  config: MieruConfig,
  target: Target,
  relay: { host: string; port: number; name: string },
): MieruConfig {
  const result = structuredClone(config),
    original = result.profiles[target.profile];
  if (!original?.servers?.[target.server]?.portBindings?.[target.binding])
    throw new Error('配置目标不存在');
  const server = original.servers[target.server],
    binding = server.portBindings[target.binding];
  if (
    (server.domainName || server.ipAddress) !== target.host ||
    binding.port !== target.port ||
    binding.protocol !== target.protocol
  )
    throw new Error('配置与购买的节点不一致');
  const profileName = `MSBOOST · ${relay.name}`,
    isIp = relay.host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(relay.host);
  result.profiles = [
    {
      ...original,
      profileName,
      servers: [
        {
          ...server,
          ipAddress: isIp ? relay.host : '',
          domainName: isIp ? '' : relay.host,
          portBindings: [{ port: relay.port, protocol: target.protocol }],
        },
      ],
    },
  ];
  result.activeProfile = profileName;
  return result;
}
export function downloadJson(config: unknown, name = 'msboost-mieru.json') {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
