# 54.0 未知残盒与抽停工具

**v0.2.1 主流程简化版**。到店只输入接手时剩余抽数，再设置个人喜好或价格、单抽价和可选预算。此前被抽走的款式保持未知；只录入自己接手后实际抽到的角色和立绘。

下载 [v0.2.1 开发分支 ZIP](https://github.com/fazetw1stzz/arknights-pass-simulator/archive/refs/heads/codex/residual-risk-v0.2.zip)，或进入[开发分支](https://github.com/fazetw1stzz/arknights-pass-simulator/tree/codex/residual-risk-v0.2)选择 Code → Download ZIP。请完整解压后运行，勿在压缩包内直接启动。此入口随分支更新；固定版本可按提交SHA下载。main保持原样，PR仍为草稿；未部署网站。

## 启动

需要 **Python 3.10+** 和现代浏览器，运行无需第三方包、Node或npm。完整解压后双击 **start.cmd**，保留窗口，浏览器打开 **http://127.0.0.1:8765/**。没有符合版本的Python时会提示；本包未内置Python。

也可在程序目录的PowerShell运行：

```powershell
python -B server.py --open-browser
```

关闭启动窗口，或在其中按Ctrl+C并按需输入Y，即可停止。端口占用时使用：

```powershell
.\start.cmd --port 8766
```

服务只监听127.0.0.1；关闭网页标签不会关闭服务。

## 日常流程

1. 选择54.0，填写**接手时现场剩余抽数**。确认理解每款各一份的测试假设。
2. 用喜好或个人参考价格给14款赋值，明确自己的目标范围。喜好可选仅我推／我推加不错；价格模式逐款勾选目标。
3. 填单抽价格和可选个人预算，查看建议。喜好权重与愿付尺度是可编辑示例，不是科学校准或市场价格。
4. 查看下一抽目标概率、盒中零目标概率、按策略最终未命中概率、预计追加花费及结果分布。
5. **自己实际抽取后**录入角色与立绘；更新剩余数量、预算和后验，再给建议。支持撤销误录、保存恢复与JSON导入导出。

普通页面没有前人行为选择、前人目标、命中阈值或前人抽数设置，也没有填写前人已抽款式的步骤。新会话固定使用`random_removal`未知移除基线。

## 简短模型边界

**此前移除的身份未知，采用均匀未知移除基线；整盒每款一份仍为待核实的测试假设，无法仅凭剩余数确认真实库存。** 这不是已验证的人群行为模型。

已亲自观察到的款式会排除，其余未见款式只表示“仍有可能”，不会全部当作肯定在盒里。例如原14款、接手剩5、自己记录2款后：实际剩3，仍有12个未亲自观察身份；基线下每个身份在盒内概率3/12、下一抽概率1/12，未来最多再抽3次。

只把其中2款作为目标时，该例下一抽命中1/6，当前盒中零目标概率6/11；若预算足够并强制抽完3件，至少命中概率5/11。实际自适应策略可能提前停手，其成功率与抽空对照分别展示。

目标用于命中风险统计；抽停建议仍按全部固定估值减新增支出优化。未来累计净效用包含下一抽，不重复扣此前已花费。喜好元等值不是现金利润，正期望不是抽取保证。

估值、抽价和预算在会话内固定，修改应明确创建新会话。

## 旧记录和恢复

- 既有随机移除v2会话可继续恢复、录入、撤销和导出。
- 旧`target_stop`／`fixed_draws`研究情景会话仍保存在本机列表，可选中原样导出；简化主流程不激活、不计算其建议，也不把它偷偷改成随机会话。请新建未知残盒会话。
- 旧非随机JSON导入会明确提示不适用于主流程，原文件及本机旧记录保持不变。
- 同会话ID若对应旧研究情景，或固定配置发生变化，拒绝覆盖，避免改写旧记录的解释。
- v1会话仍由核心明确诊断版本不兼容，可使用已保留的v0.1历史程序查看；没有静默迁移。

保存数据仍在原浏览器存储中，本次程序更新不会读取或上传个人记录。

## 分层和内部研究

核心仍为`residual-items-v2`、schema2；本次只简化普通界面与会话入口，没有改变数学模型。

| 文件 | 用途 |
|---|---|
| public/app.mjs / index.html / styles.css | 简化主流程与风险展示 |
| public/session-policy.mjs | 主流程会话准入、保护旧记录及导出选择 |
| engine.py / public/model.mjs | Python与JS精确基准，保留策略情景内部研究 |
| public/api.mjs / server.py | 同版本提供方与本机服务 |
| public/data/box54.json | 54.0款式、版本与资料来源 |

`fixed_draws`、`target_stop`生成机制及其既有测试留作内部研究；普通页面不会读取隐藏旧控件调用它们。若使用内部API，仍需明确选择并提供可解释假设，不可当成已知现场事实。

## 测试与静态预览

开发测试使用Node18+；实际环境和测试结果见QA.md：

```powershell
python -B -m unittest discover -s . -p "test_*.py"
node tests/test_port.mjs
node tests/test_ui_helpers.mjs
node tests/test_transport.mjs
node tests/test_session_policy.mjs
node tests/test_main_flow.mjs
```

`tests/test_main_flow.mjs`在内存mock环境检查实际app控制流，不代表真实浏览器验收。

```powershell
python -B build_static.py
python -B -m http.server 8766 --bind 127.0.0.1 --directory dist
```

dist也使用相同JS模型及主流程保护，需要通过HTTP访问，不能直接双击HTML。Python／静态提供方启动后，可分别运行既有内部接口回归：

```powershell
node tests/test_provider.mjs http://127.0.0.1:8765/
node tests/test_provider.mjs http://127.0.0.1:8766/ dist
```

## 商品资料

第54期7角色各常规VER／精英二VER，共14款：凯尔希·思衡托、可露希尔、维伊、谬因、裂响、佩德洛、哈蒂娅。每款各一份装箱仍未核实。

- 代购整组资料：https://cyapan.net/items/6a535dda7e6f350001327945
- 代购单盒资料：https://cyapan.net/items/6a535df27e6f350001327953
- 社区目录：https://github.com/awadwd/ArknightsAuthorization_Series-mirror

所有14款参考市场价格仍为null。25只作历史输入示例，未当成核实官价；商品图无自由授权且此前下载失败，继续使用真实姓名文字卡。独立非官方工具，本次不新增许可证或收藏、配对、重复折损功能。
