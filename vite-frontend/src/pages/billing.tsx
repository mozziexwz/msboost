import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";

import { Button } from "@/shadcn-bridge/heroui/button";
import { Card, CardBody, CardHeader } from "@/shadcn-bridge/heroui/card";
import { Input } from "@/shadcn-bridge/heroui/input";
import { Switch } from "@/shadcn-bridge/heroui/switch";
import {
  createPlan,
  deletePlan,
  generateCards,
  getCards,
  getPlans,
  redeemCard,
  updatePlan,
  type CardRecord,
  type PlanData,
  type PlanMutationData,
} from "@/api";
import { isAdmin } from "@/utils/auth";

type EditablePlan = PlanMutationData & { id?: number };

const emptyPlan = (): EditablePlan => ({
  name: "",
  days: 30,
  flowGB: 50,
  bandwidthMbps: 0,
  priceCents: 0,
  enabled: 1,
  trial: 0,
  sortOrder: 0,
});

const cardStatusText = (status: number) => {
  if (status === 0) return "未使用";
  if (status === 1) return "已兑换";
  return "已停用";
};

export default function BillingPage() {
  const admin = isAdmin();
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [planDraft, setPlanDraft] = useState<EditablePlan>(emptyPlan);
  const [savingPlan, setSavingPlan] = useState(false);
  const [cardPlanID, setCardPlanID] = useState<number>(0);
  const [cardCount, setCardCount] = useState("1");
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);

  const planByID = useMemo(
    () => new Map(plans.map((plan) => [plan.id, plan])),
    [plans],
  );

  const load = async () => {
    setLoading(true);
    try {
      const [plansResponse, cardsResponse] = await Promise.all([
        getPlans(),
        admin ? getCards() : Promise.resolve(null),
      ]);
      if (plansResponse.code !== 0) {
        toast.error(plansResponse.msg || "无法加载套餐");
        return;
      }
      const nextPlans = plansResponse.data || [];
      setPlans(nextPlans);
      if (cardPlanID === 0 && nextPlans.length > 0) {
        setCardPlanID(nextPlans[0].id);
      }
      if (cardsResponse?.code === 0) setCards(cardsResponse.data || []);
    } catch {
      toast.error("无法加载套餐数据，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const redeem = async () => {
    if (!redeemCode.trim()) {
      toast.error("请输入卡密");
      return;
    }
    setRedeeming(true);
    try {
      const response = await redeemCard(redeemCode);
      if (response.code !== 0) {
        toast.error(response.msg || "卡密兑换失败");
        return;
      }
      setRedeemCode("");
      toast.success(response.data.message || "套餐已开通");
      await load();
    } finally {
      setRedeeming(false);
    }
  };

  const savePlan = async () => {
    if (!planDraft.name.trim()) {
      toast.error("请输入套餐名称");
      return;
    }
    setSavingPlan(true);
    try {
      const response = planDraft.id
        ? await updatePlan(planDraft as PlanMutationData & { id: number })
        : await createPlan(planDraft);
      if (response.code !== 0) {
        toast.error(response.msg || "套餐保存失败");
        return;
      }
      setPlanDraft(emptyPlan());
      toast.success("套餐已保存");
      await load();
    } finally {
      setSavingPlan(false);
    }
  };

  const editPlan = (plan: PlanData) => {
    setPlanDraft({
      id: plan.id,
      name: plan.name,
      days: plan.days,
      flowGB: plan.flowGB,
      bandwidthMbps: plan.bandwidthMbps,
      priceCents: plan.priceCents,
      enabled: plan.enabled,
      trial: plan.trial,
      sortOrder: plan.sortOrder,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const removePlan = async (plan: PlanData) => {
    if (!window.confirm(`确定删除套餐“${plan.name}”吗？未使用或已使用卡密的套餐不可删除。`)) return;
    const response = await deletePlan(plan.id);
    if (response.code !== 0) {
      toast.error(response.msg || "套餐删除失败");
      return;
    }
    toast.success("套餐已删除");
    if (planDraft.id === plan.id) setPlanDraft(emptyPlan());
    await load();
  };

  const makeCards = async () => {
    const count = Number(cardCount);
    if (!cardPlanID || !Number.isInteger(count) || count < 1 || count > 500) {
      toast.error("请选择套餐，并输入 1 至 500 的生成数量");
      return;
    }
    const response = await generateCards(cardPlanID, count);
    if (response.code !== 0) {
      toast.error(response.msg || "卡密生成失败");
      return;
    }
    setGeneratedCodes(response.data.codes || []);
    toast.success("卡密已生成，请立即复制并安全保存");
    await load();
  };

  const copyCodes = async () => {
    if (generatedCodes.length === 0) return;
    try {
      await navigator.clipboard.writeText(generatedCodes.join("\n"));
      toast.success("卡密已复制");
    } catch {
      toast.error("复制失败，请手动复制下方文本");
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">MSBOOST</p>
        <h1 className="text-3xl font-bold tracking-tight">套餐与卡密</h1>
        <p className="text-sm text-default-500">
          使用卡密开通套餐。新套餐会覆盖原有有效期和流量额度，并将已用流量清零，不会叠加。
        </p>
      </header>

      <Card>
        <CardHeader className="pb-0">
          <h2 className="text-lg font-semibold">兑换卡密</h2>
        </CardHeader>
        <CardBody className="flex flex-col gap-3 sm:flex-row">
          <Input
            className="flex-1"
            label="卡密"
            placeholder="MSB-XXXXX-XXXXX-XXXXX-XXXXX"
            value={redeemCode}
            variant="bordered"
            onChange={(event) => setRedeemCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !redeeming) void redeem();
            }}
          />
          <Button className="sm:mt-6" color="primary" isLoading={redeeming} onPress={() => void redeem()}>
            开通套餐
          </Button>
        </CardBody>
      </Card>

      <section>
        <h2 className="mb-3 text-lg font-semibold">可用套餐</h2>
        {loading ? (
          <p className="text-sm text-default-500">正在加载套餐…</p>
        ) : plans.length === 0 ? (
          <Card><CardBody className="text-sm text-default-500">管理员暂未上架套餐，请使用卡密前联系管理员。</CardBody></Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {plans.filter((plan) => admin || plan.enabled === 1).map((plan) => (
              <Card key={plan.id} className={plan.enabled === 1 ? "border border-primary-100" : "opacity-60"}>
                <CardHeader className="flex flex-row items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{plan.name}</h3>
                    <p className="text-sm text-default-500">{plan.days} 天 · {plan.flowGB} GB</p>
                  </div>
                  {plan.trial === 1 && <span className="rounded-full bg-success-100 px-2 py-1 text-xs text-success-700">体验</span>}
                </CardHeader>
                <CardBody className="space-y-1 pt-0 text-sm text-default-600">
                  <p>{plan.bandwidthMbps > 0 ? `${plan.bandwidthMbps} Mbps 带宽` : "不限带宽"}</p>
                  <p>{plan.priceCents === 0 ? "免费卡可用" : `参考价 ¥${(plan.priceCents / 100).toFixed(2)}`}</p>
                  {admin && <p className="text-xs">{plan.enabled === 1 ? "已上架" : "已停用"}</p>}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      {admin && (
        <section className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <h2 className="text-lg font-semibold">{planDraft.id ? "编辑套餐" : "新建套餐"}</h2>
                <p className="text-sm text-default-500">有效期限定为 1 至 31 天；价格可为 0 元。</p>
              </div>
            </CardHeader>
            <CardBody className="grid gap-3 sm:grid-cols-2">
              <Input className="sm:col-span-2" label="套餐名称" value={planDraft.name} variant="bordered" onChange={(event) => setPlanDraft((value) => ({ ...value, name: event.target.value }))} />
              <NumberField label="有效天数" value={planDraft.days} onChange={(days) => setPlanDraft((value) => ({ ...value, days }))} />
              <NumberField label="流量 GB" value={planDraft.flowGB} onChange={(flowGB) => setPlanDraft((value) => ({ ...value, flowGB }))} />
              <NumberField label="带宽 Mbps（0=不限）" value={planDraft.bandwidthMbps} onChange={(bandwidthMbps) => setPlanDraft((value) => ({ ...value, bandwidthMbps }))} />
              <NumberField label="价格（分，可为 0）" value={planDraft.priceCents} onChange={(priceCents) => setPlanDraft((value) => ({ ...value, priceCents }))} />
              <NumberField label="排序" value={planDraft.sortOrder} onChange={(sortOrder) => setPlanDraft((value) => ({ ...value, sortOrder }))} />
              <div className="flex items-center gap-6 sm:col-span-2">
                <Switch isSelected={planDraft.enabled === 1} onValueChange={(selected) => setPlanDraft((value) => ({ ...value, enabled: selected ? 1 : 0 }))}>上架</Switch>
                <Switch isSelected={planDraft.trial === 1} onValueChange={(selected) => setPlanDraft((value) => ({ ...value, trial: selected ? 1 : 0 }))}>免费体验</Switch>
              </div>
              <div className="flex gap-3 sm:col-span-2">
                <Button color="primary" isLoading={savingPlan} onPress={() => void savePlan()}>{planDraft.id ? "保存套餐" : "创建套餐"}</Button>
                {planDraft.id && <Button variant="bordered" onPress={() => setPlanDraft(emptyPlan())}>取消编辑</Button>}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><div><h2 className="text-lg font-semibold">生成卡密</h2><p className="text-sm text-default-500">卡密只显示一次；数据库只保存不可逆摘要。</p></div></CardHeader>
            <CardBody className="space-y-3">
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={cardPlanID} onChange={(event) => setCardPlanID(Number(event.target.value))}>
                <option value={0}>选择套餐</option>
                {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}（{plan.days} 天 / {plan.flowGB} GB）</option>)}
              </select>
              <Input label="生成数量" type="number" value={cardCount} variant="bordered" onChange={(event) => setCardCount(event.target.value)} />
              <Button color="primary" onPress={() => void makeCards()}>生成卡密</Button>
              {generatedCodes.length > 0 && (
                <div className="space-y-2 rounded-lg border border-warning-200 bg-warning-50 p-3 dark:bg-warning-950/20">
                  <p className="text-sm font-medium">仅此一次：请立即保存卡密</p>
                  <textarea className="min-h-32 w-full rounded border bg-background p-2 font-mono text-xs" readOnly value={generatedCodes.join("\n")} />
                  <Button size="sm" variant="bordered" onPress={() => void copyCodes()}>复制全部</Button>
                </div>
              )}
            </CardBody>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader><h2 className="text-lg font-semibold">后台套餐与卡密管理</h2></CardHeader>
            <CardBody className="space-y-5">
              <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b text-default-500"><tr><th className="p-2">套餐</th><th className="p-2">有效期</th><th className="p-2">流量</th><th className="p-2">状态</th><th className="p-2">操作</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id} className="border-b"><td className="p-2">{plan.name}</td><td className="p-2">{plan.days} 天</td><td className="p-2">{plan.flowGB} GB</td><td className="p-2">{plan.enabled === 1 ? "上架" : "停用"}</td><td className="flex gap-2 p-2"><Button size="sm" variant="bordered" onPress={() => editPlan(plan)}>编辑</Button><Button color="danger" size="sm" variant="bordered" onPress={() => void removePlan(plan)}>删除</Button></td></tr>)}</tbody></table></div>
              <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b text-default-500"><tr><th className="p-2">卡密 ID</th><th className="p-2">套餐</th><th className="p-2">状态</th><th className="p-2">兑换用户</th><th className="p-2">生成时间</th></tr></thead><tbody>{cards.map((card) => <tr key={card.id} className="border-b"><td className="p-2">#{card.id}</td><td className="p-2">{card.planName || planByID.get(card.planId)?.name || "已删除套餐"}</td><td className="p-2">{cardStatusText(card.status)}</td><td className="p-2">{card.redeemedByUserId || "—"}</td><td className="p-2">{new Date(card.createdTime).toLocaleString()}</td></tr>)}</tbody></table></div>
            </CardBody>
          </Card>
        </section>
      )}
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <Input label={label} type="number" value={String(value)} variant="bordered" onChange={(event) => onChange(Number(event.target.value) || 0)} />;
}
