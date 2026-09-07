import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { Turnstile } from "@marsidev/react-turnstile";
import { motion } from "framer-motion";

import { Button } from "@/shadcn-bridge/heroui/button";
import { Card, CardBody, CardHeader } from "@/shadcn-bridge/heroui/card";
import { Checkbox } from "@/shadcn-bridge/heroui/checkbox";
import { Input } from "@/shadcn-bridge/heroui/input";
import DefaultLayout from "@/layouts/default";
import {
  checkCaptcha,
  getPublicConfigByName,
  getRegistrationSettings,
  login,
  registerAccount,
  type LoginData,
  type RegistrationSettings,
} from "@/api";
import { writeLoginSession } from "@/utils/session";

type Mode = "login" | "register";

const numericQQMailbox = /^[0-9]+@qq\.com$/;

export default function IndexPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [loading, setLoading] = useState(false);
  const [showLoginCaptcha, setShowLoginCaptcha] = useState(false);
  const [loginSiteKey, setLoginSiteKey] = useState("");
  const [registrationSettings, setRegistrationSettings] =
    useState<RegistrationSettings | null>(null);
  const [loginForm, setLoginForm] = useState({
    username: "",
    password: "",
    captchaId: "",
  });
  const [registerForm, setRegisterForm] = useState({
    email: "",
    password: "",
    confirmPassword: "",
    inviteCode: "",
    turnstileToken: "",
    agreementAccepted: false,
  });

  useEffect(() => {
    void getRegistrationSettings().then((response) => {
      if (response.code === 0) setRegistrationSettings(response.data);
    });
  }, []);

  const completeLogin = async (captchaToken?: string) => {
    const payload: LoginData = {
      username: loginForm.username.trim(),
      password: loginForm.password,
      captchaId: captchaToken || loginForm.captchaId,
    };
    const response = await login(payload);
    if (response.code !== 0) {
      toast.error(response.msg || "登录失败");
      setLoginForm((current) => ({ ...current, captchaId: "" }));
      return;
    }
    writeLoginSession(response.data);
    toast.success("登录成功");
    navigate(response.data.requirePasswordChange ? "/change-password" : "/dashboard");
  };

  const handleLogin = async () => {
    if (!loginForm.username.trim() || !loginForm.password) {
      toast.error("请输入账号和密码");
      return;
    }
    setLoading(true);
    try {
      const captcha = await checkCaptcha();
      if (captcha.code !== 0) {
        toast.error(captcha.msg || "无法检查验证码状态");
        return;
      }
      if (captcha.data === 0) {
        await completeLogin();
        return;
      }
      const siteKey = await getPublicConfigByName("cloudflare_site_key");
      if (siteKey.code !== 0 || !siteKey.data?.value) {
        toast.error("管理员尚未完成登录验证码配置");
        return;
      }
      setLoginSiteKey(siteKey.data.value);
      setShowLoginCaptcha(true);
    } catch {
      toast.error("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    const settings = registrationSettings;
    if (!settings?.enabled) {
      toast.error("管理员暂未开放注册");
      return;
    }
    const email = registerForm.email.trim().toLowerCase();
    if (!numericQQMailbox.test(email)) {
      toast.error("仅支持纯数字 QQ 邮箱，例如 123456@qq.com");
      return;
    }
    if (registerForm.password.length < 8) {
      toast.error("密码至少需要 8 位");
      return;
    }
    if (registerForm.password !== registerForm.confirmPassword) {
      toast.error("两次密码输入不一致");
      return;
    }
    if (!registerForm.agreementAccepted) {
      toast.error("请先阅读并同意服务协议");
      return;
    }
    if (settings.turnstileEnabled && !registerForm.turnstileToken) {
      toast.error("请先完成 Turnstile 验证");
      return;
    }

    setLoading(true);
    try {
      const response = await registerAccount({
        email,
        password: registerForm.password,
        inviteCode: registerForm.inviteCode,
        turnstileToken: registerForm.turnstileToken,
        agreementAccepted: registerForm.agreementAccepted,
      });
      if (response.code !== 0) {
        toast.error(response.msg || "注册失败");
        return;
      }
      setLoginForm({ username: email, password: "", captchaId: "" });
      setMode("login");
      toast.success("注册成功，请登录后使用卡密开通套餐");
    } catch {
      toast.error("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next: Mode) => {
    setShowLoginCaptcha(false);
    setMode(next);
  };

  return (
    <DefaultLayout>
      <section className="flex min-h-[calc(100dvh-120px)] items-center justify-center py-10 sm:min-h-[calc(100dvh-200px)]">
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md px-4 sm:px-0"
          initial={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.3 }}
        >
          <Card className="w-full border border-primary-100 shadow-xl">
            <CardHeader className="flex flex-col items-center gap-2 px-6 pb-2 pt-7 text-center">
              <span className="rounded-full bg-primary-100 px-3 py-1 text-xs font-semibold tracking-[0.18em] text-primary-700 dark:bg-primary-900/40 dark:text-primary-200">
                MSBOOST
              </span>
              <h1 className="text-2xl font-bold tracking-tight">
                {mode === "login" ? "登录你的专属游戏节点" : "创建 MSBOOST 账号"}
              </h1>
              <p className="text-sm text-default-500">
                {mode === "login"
                  ? "登录后可部署节点、使用卡密并管理隧道中转。"
                  : "仅支持纯数字 QQ 邮箱注册；请先确认你已自备服务器。"}
              </p>
            </CardHeader>
            <CardBody className="space-y-4 px-6 pb-7 pt-5">
              {mode === "login" ? (
                <>
                  <Input
                    isDisabled={loading}
                    label="账号"
                    placeholder="管理员账号或 QQ 邮箱"
                    value={loginForm.username}
                    variant="bordered"
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, username: event.target.value }))
                    }
                  />
                  <Input
                    isDisabled={loading}
                    label="密码"
                    placeholder="请输入密码"
                    type="password"
                    value={loginForm.password}
                    variant="bordered"
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, password: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !loading) void handleLogin();
                    }}
                  />
                  <Button
                    className="w-full"
                    color="primary"
                    isLoading={loading}
                    size="lg"
                    onPress={() => void handleLogin()}
                  >
                    登录
                  </Button>
                  <p className="text-center text-sm text-default-500">
                    还没有账号？{" "}
                    <button className="font-medium text-primary" type="button" onClick={() => switchMode("register")}>
                      注册账号
                    </button>
                  </p>
                </>
              ) : (
                <>
                  <Input
                    isDisabled={loading}
                    label="QQ 邮箱"
                    placeholder="123456@qq.com"
                    value={registerForm.email}
                    variant="bordered"
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, email: event.target.value }))
                    }
                  />
                  <Input
                    isDisabled={loading}
                    label="设置密码"
                    placeholder="至少 8 位"
                    type="password"
                    value={registerForm.password}
                    variant="bordered"
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, password: event.target.value }))
                    }
                  />
                  <Input
                    isDisabled={loading}
                    label="确认密码"
                    placeholder="再次输入密码"
                    type="password"
                    value={registerForm.confirmPassword}
                    variant="bordered"
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, confirmPassword: event.target.value }))
                    }
                  />
                  {registrationSettings?.inviteRequired && (
                    <Input
                      isDisabled={loading}
                      label="邀请码"
                      placeholder="请输入邀请码"
                      value={registerForm.inviteCode}
                      variant="bordered"
                      onChange={(event) =>
                        setRegisterForm((current) => ({ ...current, inviteCode: event.target.value }))
                      }
                    />
                  )}
                  {registrationSettings?.turnstileEnabled && registrationSettings.turnstileSiteKey && (
                    <div className="flex justify-center overflow-hidden rounded-lg border border-default-200 p-2">
                      <Turnstile
                        siteKey={registrationSettings.turnstileSiteKey}
                        onError={() => toast.error("Turnstile 验证失败，请刷新后重试")}
                        onExpire={() =>
                          setRegisterForm((current) => ({ ...current, turnstileToken: "" }))
                        }
                        onSuccess={(token) =>
                          setRegisterForm((current) => ({ ...current, turnstileToken: token }))
                        }
                      />
                    </div>
                  )}
                  <Checkbox
                    isSelected={registerForm.agreementAccepted}
                    onValueChange={(accepted) =>
                      setRegisterForm((current) => ({ ...current, agreementAccepted: accepted }))
                    }
                  >
                    我已阅读并同意服务协议、隐私政策与可接受使用政策
                  </Checkbox>
                  <Button
                    className="w-full"
                    color="primary"
                    isDisabled={registrationSettings?.enabled === false}
                    isLoading={loading}
                    size="lg"
                    onPress={() => void handleRegister()}
                  >
                    {registrationSettings?.enabled === false ? "注册暂未开放" : "创建账号"}
                  </Button>
                  <p className="text-center text-sm text-default-500">
                    已有账号？{" "}
                    <button className="font-medium text-primary" type="button" onClick={() => switchMode("login")}>
                      返回登录
                    </button>
                  </p>
                </>
              )}
            </CardBody>
          </Card>
        </motion.div>
      </section>

      {showLoginCaptcha && loginSiteKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-900">
            <p className="mb-4 text-center text-sm font-medium">请完成安全验证</p>
            <div className="flex justify-center">
              <Turnstile
                siteKey={loginSiteKey}
                onError={() => {
                  toast.error("验证失败，请刷新重试");
                  setShowLoginCaptcha(false);
                }}
                onExpire={() => setLoginForm((current) => ({ ...current, captchaId: "" }))}
                onSuccess={(token) => {
                  setShowLoginCaptcha(false);
                  setLoading(true);
                  void completeLogin(token).finally(() => setLoading(false));
                }}
              />
            </div>
          </div>
        </div>
      )}
    </DefaultLayout>
  );
}
