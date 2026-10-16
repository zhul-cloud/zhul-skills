[CmdletBinding()]
param(
    [string]$Agent = 'claude',
    [string]$Skill,
    [switch]$Help
)

# 原生目录 Junction 保留链接行为，不需要开启符号链接特权。
$ErrorActionPreference = 'Stop'
if ($Help) {
    Write-Output @'
用法: .\install.ps1 [-Agent both|claude|codex] [-Skill <技能目录名称>]
默认安装全部技能到 Claude 的 %USERPROFILE%\.claude\skills。
Codex 使用 %USERPROFILE%\.agents\skills；both 安装到两端。
示例: .\install.ps1 -Agent both -Skill '烛龙智能询价'
'@
    exit 0
}

function Get-LinkState([string]$Source, [string]$Target) {
    $item = Get-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return 'missing' }
    if (!$item.PSIsContainer -or
        !($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.LinkType -notin @('Junction', 'SymbolicLink')) { return 'conflict' }
    $linked = [string]@($item.Target)[0]
    if (![IO.Path]::IsPathRooted($linked)) {
        $linked = Join-Path $item.Parent.FullName $linked
    }
    if ([IO.Path]::GetFullPath($linked).TrimEnd([char]92) -ine
        [IO.Path]::GetFullPath($Source).TrimEnd([char]92)) { return 'conflict' }
    if (!(Test-Path -LiteralPath (Join-Path $Target 'SKILL.md') -PathType Leaf)) { return 'conflict' }
    return 'same'
}

try {
    if ($Agent -notin @('claude', 'codex', 'both')) { throw "未知 agent: $Agent" }
    if ($PSBoundParameters.ContainsKey('Skill') -and [string]::IsNullOrWhiteSpace($Skill)) { throw 'Skill 不能为空' }
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) { throw 'USERPROFILE 未设置' }
    $skills = @(Get-ChildItem -LiteralPath $PSScriptRoot -Directory | ForEach-Object {
        Get-ChildItem -LiteralPath $_.FullName -Directory | Where-Object {
            (Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf) -and
            (!$Skill -or $_.Name -ceq $Skill)
        }
    })
    if ($skills.Count -eq 0) { throw "未找到技能: $Skill" }
    $duplicates = @($skills | Group-Object Name | Where-Object Count -gt 1)
    if ($duplicates.Count) { throw "技能目录名称重复: $($duplicates.Name -join ', ')" }
    $destinations = @()
    if ($Agent -ne 'codex') { $destinations += Join-Path $env:USERPROFILE '.claude\skills' }
    if ($Agent -ne 'claude') { $destinations += Join-Path $env:USERPROFILE '.agents\skills' }

    # 先检查全部目标，冲突时不删除、不覆盖，也不进行部分安装。
    foreach ($destination in $destinations) {
        foreach ($entry in $skills) {
            $target = Join-Path $destination $entry.Name
            if ((Get-LinkState $entry.FullName $target) -eq 'conflict') {
                throw "目标已存在: $target。请先将它移到技能搜索目录外备份，再重新安装；脚本不会删除或覆盖它。"
            }
        }
    }
    foreach ($destination in $destinations) {
        $null = [IO.Directory]::CreateDirectory($destination)
        foreach ($entry in $skills) {
            $target = Join-Path $destination $entry.Name
            $state = Get-LinkState $entry.FullName $target
            if ($state -eq 'conflict') { throw "目标发生冲突: $target；请移到技能搜索目录外备份后重试。" }
            if ($state -eq 'missing') {
                $null = New-Item -ItemType Junction -Path $target -Target $entry.FullName
            }
            if ((Get-LinkState $entry.FullName $target) -ne 'same') { throw "未创建真实目录链接: $target" }
            Write-Output "已连接: $target"
        }
    }
    Write-Output '安装完成。仓库执行 git pull 后，链接中的技能文件会同步更新。'
    exit 0
} catch {
    [Console]::Error.WriteLine("安装失败: $($_.Exception.Message)")
    exit 1
}
