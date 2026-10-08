# Raspberry Pi atrás da TV: preparo e manutenção

Este guia descreve o comportamento de [preparar-pi.sh](preparar-pi.sh),
[agente.js](agente.js), [iniciar-quiosque.sh](iniciar-quiosque.sh) e
[corptv-agente.service](corptv-agente.service). O
[checklist de instalação](CHECKLIST-INSTALACAO-PI.md) é uma referência complementar;
algumas instruções antigas dele são manuais e já foram automatizadas pelo preparo.

Os comandos abaixo são para executar **na Pi**, no terminal do usuário da área
de trabalho. `sudo` aparece onde é necessário. O endereço `tv.exemplo.local`,
o nome `pi-tv-01` e a tela `tela-01` são exemplos: substitua pelos
valores da instalação. `127.0.0.1` e `localhost` significam a própria Pi e devem
continuar assim. Não publique saídas de diagnóstico com dados reais da instalação.

## 1. Como as peças se ligam

```text
Energia → Raspberry Pi → rede → agente → cartão → Chromium em tela cheia → HDMI → TV
                                  ↑                 ↑
                         programação e arquivos     http://127.0.0.1:8080
                              do servidor           servido pela própria Pi
```

O agente baixa cada arquivo uma vez e o reutiliza enquanto ele estiver igual e
presente no cartão. Compara versão e tamanho; baixa novamente se o arquivo mudou
ou falta no cache. Antes de pôr um arquivo baixado no lugar, confere o SHA-256 que
o servidor informa na programação; arquivo que não confere é descartado. Um
download incompleto fica como `.parcial` e pode ser retomado.
O navegador toca a cópia local, sem buscar o vídeo no servidor a cada reprodução.

A rede continua sendo usada para consultar programação, registrar o aparelho,
avisar que o player está exibindo e buscar atualizações. Portanto, tocar do cartão
reduz o tráfego; não significa ausência total de tráfego. Sem rede, o conteúdo já
baixado continua disponível **enquanto sua agenda permitir**. Conteúdo vencido sai
da exibição mesmo offline. A primeira preparação precisa de rede e dos downloads.

Na instalação pelo serviço, o cache fica em `/var/lib/corptv/cache`. O agente
atende apenas na interface local, na porta `8080`. A página do painel deve ser
aberta em outro computador: o Chromium da Pi é dedicado à exibição local.

## 2. Material e sistema

- Raspberry Pi 4 Model B.
- Fonte oficial USB-C para Pi 4, classe **5 V / 3 A**. A especificação da
  [fonte oficial de 15 W](https://www.raspberrypi.com/products/type-c-power-supply/)
  é **5,1 V / 3 A**. Não alimente a Pi pela USB da TV.
- Case ventilado, com dissipação adequada. Atrás da TV a Pi pode chegar a
  **75 °C ou mais**; deixe as entradas de ar livres e confira a temperatura após instalar.
- Cartão microSD de boa marca, preferencialmente de alta durabilidade. Use pelo
  menos 32 GB e confira se há espaço para o sistema e os vídeos.
- Cabo micro-HDMI na porta **HDMI 0**, a mais próxima da entrada de energia da Pi 4.
  Ligue também a TV antes de iniciar a Pi, para que a saída de áudio seja detectada.
- Rede por cabo quando disponível; Wi-Fi pode ser cadastrado como descrito abaixo.
- Teclado e mouse para o preparo e a manutenção local.

Grave **Raspberry Pi OS de 64 bits com desktop** no cartão. Configure um usuário
local, por exemplo `operador`, e um nome genérico como `pi-tv-01`. O serviço do agente
não depende desse nome: usa um usuário temporário próprio, criado pelo systemd.

Antes do preparo, a Pi precisa ter uma conexão funcional, `curl` e Chromium.
O preparo instala Node.js se ele não existir, mas **não instala o desktop, o
Chromium ou o curl**, nem cadastra a primeira conexão de rede. No desktop atual,
se esses programas faltarem:

```bash
sudo apt update
sudo apt install -y curl chromium
```

O quiosque procura `chromium-browser` e depois `chromium`. Node.js precisa ser
versão 18 ou superior; se uma versão antiga já estiver instalada, o preparo para
com erro em vez de atualizá-la automaticamente. O serviço usa `/usr/bin/node`.

## 3. Preparar uma Pi nova

No painel, com perfil TI, abra **Aparelhos → Adicionar Raspberry** e copie o
comando de preparo. Use o endereço completo mostrado pelo painel. Exemplo:

```bash
curl -fsSL http://tv.exemplo.local/pi/preparar.sh | sudo bash
```

Execute no terminal do usuário que terá a sessão gráfica. O script escolhe
`SUDO_USER`; se estiver executando como root, tenta o usuário de UID 1000.
Confira essa escolha se houver vários usuários na Pi.

O endereço `/pi/preparar.sh` entrega o script com o servidor preenchido. Executar
diretamente a cópia do repositório, que contém `__SERVIDOR__`, não é equivalente.
Não é necessário informar o nome de uma tela: a seleção normal acontece no painel.

Antes de preparar uma Pi que já está em uso, guarde uma cópia dos arquivos
existentes listados nas tabelas abaixo e anote os ajustes de rede, login e tela.
Guarde os backups somente em local privado. O preparo não faz backup geral e pode
sobrescrever versões anteriores dos próprios arquivos.

### O que o preparo faz

1. Confere `/health` no servidor. Se receber uma tela como argumento opcional,
   confere também se ela existe.
2. Se o endereço tiver um domínio, acrescenta seu sufixo a `ipv4.dns-search` dos
   perfis Ethernet e Wi-Fi conhecidos do NetworkManager. No exemplo, o sufixo é
   `exemplo.local`. Não configura um servidor DNS novo nem altera o roteador.
3. Desliga a economia de energia do Wi-Fi e, se `iw` existir, aplica também
   `power_save off` em `wlan0` na sessão atual.
4. Desativa a conexão automática de perfis Wi-Fi WPA-PSK/SAE sem senha salva,
   desde que não estejam em uso. Perfis abertos e de autenticação por usuário
   ficam como estavam. Instala o comando `corptv-wifi` quando há NetworkManager.
5. Instala Node.js via `apt-get` somente se faltar e verifica sua versão.
6. Baixa e confere a sintaxe do agente e do quiosque, instala os arquivos abaixo,
   habilita e reinicia o serviço do agente. Confere o `/status` local.
7. Instala autostart, atalho e políticas do Chromium. Com `raspi-config`, solicita
   tela sem apagamento e login automático no desktop.
8. Se `/dev/watchdog` existir, configura o watchdog de hardware pelo systemd:
   prazo de 15 segundos durante o funcionamento e 2 minutos durante o reinício.
   O hardware pode reiniciar a Pi se o sistema travar e parar de alimentar o
   watchdog. Só executa `systemctl daemon-reexec` se a configuração mudar;
   sem o dispositivo, informa que pulou o passo.
9. Se acrescentou sufixos de rede, tenta reaplicá-los às interfaces conectadas
   por último. A conexão de manutenção pode cair por um instante.

### Arquivos e serviços instalados ou alterados diretamente

Aqui, `~` é a pasta do usuário da **sessão gráfica escolhida pelo preparo**.

| Arquivo ou recurso | Efeito |
| --- | --- |
| Perfis Ethernet/Wi-Fi do NetworkManager | Altera `ipv4.dns-search`; em alguns perfis Wi-Fi inativos, altera `connection.autoconnect`. Os arquivos dos perfis são gerenciados pelo NetworkManager, normalmente em `/etc/NetworkManager/system-connections/`. |
| `/etc/NetworkManager/conf.d/99-corptv-wifi.conf` | Cria ou substitui a configuração global `wifi.powersave = 2`, se o diretório existir. |
| `/usr/local/bin/corptv-wifi` | Cria ou substitui o comando de cadastro de Wi-Fi, com permissão de execução. |
| Pacote `nodejs` | Instala pelo gerenciador de pacotes somente se o comando `node` faltar. |
| `/opt/corptv-agente/agente.js` | Instala ou substitui o agente. Cria `/opt/corptv-agente` se necessário. |
| `/etc/systemd/system/corptv-agente.service` | Instala ou substitui a unidade systemd. Executa `daemon-reload`, `enable` e `restart`. A habilitação cria `/etc/systemd/system/multi-user.target.wants/corptv-agente.service`. |
| `/etc/corptv/agente.env` | Cria o diretório e grava `CORPTV_SERVIDOR`. Grava `CORPTV_TELA` se informada; sem argumento, conserva o valor anterior. Preserva outros ajustes existentes, retirando comentários antigos. |
| `/opt/corptv-agente/iniciar-quiosque.sh` | Instala ou substitui o iniciador do navegador, executável. |
| `~/.config/autostart/corptv-quiosque.desktop` | Abre o quiosque ao entrar na sessão gráfica. Cria os diretórios pais se necessário. |
| `~/.local/share/applications/corptv-quiosque.desktop` | Cria o atalho **CorporTV na TV** no menu e seus diretórios pais. |
| `/etc/chromium/policies/managed/corptv.json` | Cria diretórios e substitui a política: tradução desativada, todos os destinos bloqueados, com exceção de `127.0.0.1:8080` e `localhost:8080`. Vale também para Chromium aberto à mão. |
| `/etc/chromium.d/corptv` | Se `/etc/chromium.d` existir, acrescenta `--password-store=basic` às opções do Chromium. |
| Configurações mantidas por `raspi-config` | Executa `do_blanking 1` e `do_boot_behaviour B4`. Os arquivos internos alterados dependem da versão do Raspberry Pi OS e do desktop instalado; o preparo não fixa esses caminhos. Se faltar a ferramenta ou uma chamada falhar, imprime um aviso. |
| `/etc/systemd/system.conf.d/90-corptv-watchdog.conf` | Se `/dev/watchdog` existir, cria o diretório e grava `[Manager]`, um comentário explicativo, `RuntimeWatchdogSec=15` e `RebootWatchdogSec=2min`. Compara o conteúdo antes de gravar; somente uma mudança executa `systemctl daemon-reexec` para aplicar. |
| Diretório temporário criado por `mktemp -d` | Guarda os downloads e a montagem de `agente.env`; é removido ao encerrar o preparo. |

O único serviço CorporTV instalado é **`corptv-agente.service`**. Ele usa
`DynamicUser=yes`, `StateDirectory=corptv` e reinicia após falhas, com espera de
10 segundos. O quiosque **não é um serviço systemd**: inicia com a sessão gráfica.
O preparo não habilita SSH, não cria regras de firewall e não reinicia o
NetworkManager inteiro.

### Arquivos e ajustes criados depois, durante o funcionamento

| Arquivo ou recurso | Quem altera e para quê |
| --- | --- |
| `/var/lib/corptv` e `/var/lib/corptv/cache` | O systemd fornece a área persistente do serviço e o agente cria o cache. Com `DynamicUser`, a implementação pode usar `/var/lib/private/corptv` e um vínculo em `/var/lib/corptv`. |
| `aparelho.json` no cache | Identidade do aparelho e última tela escolhida. |
| `estado.json`, `playlist.json`, `player.html` no cache | Versões dos arquivos, programação com validade e página local do player. |
| `servidor-endereco.json` no cache | Último endereço resolvido para o nome do servidor, usado como alternativa se o DNS falhar. Não substitui a necessidade de DNS correto na instalação inicial. |
| Arquivos de mídia e `.parcial` no cache | Downloads completos ou em andamento; arquivos fora da programação são limpos pelo agente. |
| `/tmp/corptv-quiosque-<UID>.lock` | O quiosque usa `flock`, quando disponível, para evitar duas instâncias na mesma sessão. |
| `~/.config/chromium/Default/Preferences` | O quiosque corrige indicadores de encerramento anormal antes de abrir o navegador, para evitar o aviso de restaurar páginas. O Chromium também mantém seu perfil normalmente. |
| `~/.config/labwc/rc.xml` | Se labwc estiver em modo merge, o quiosque cria ou acrescenta a regra de tela cheia para a janela `corptv-tv`. Não substitui as demais regras. |
| `~/.config/labwc/rc.xml.antes-corptv` | Cópia do XML antes de acrescentar a regra a um arquivo existente. Não é criada quando o XML ainda não existia. |
| Áudio e tela da sessão | O quiosque escolhe HDMI, desativa mudo e põe o volume do sistema em 100%, usando `pactl` ou `wpctl`. Em X11, usa `xset` para desligar protetor e economia da tela. |
| Journal do sistema | Logs do serviço em `-u corptv-agente` e do navegador em `-t corptv-quiosque`. |

### Cadastrar o Wi-Fi

Depois do preparo, execute:

```bash
sudo corptv-wifi "Nome da rede"
```

Digite a senha quando for pedida; ela não aparece na tela. O comando é para rede
com senha compartilhada. Ele cria um perfil WPA-PSK em `wlan0`, guarda a senha no
sistema, habilita conexão automática e dá prioridade 10 à rede escolhida. As
outras redes Wi-Fi ficam com prioridade 0. Se já existir um perfil com o mesmo
nome, ele é apagado e recriado: guarde sua configuração antes, se precisar dela.

O comando não força a troca imediata. Para conectar agora, no terminal local:

```bash
sudo nmcli connection up "Nome da rede"
```

A troca pode interromper uma conexão remota de manutenção. Para redes com
autenticação por usuário, use a configuração apropriada do NetworkManager;
`corptv-wifi` não implementa esse tipo de cadastro.

### Terminar e conferir

Reinicie para entrar no desktop e iniciar o quiosque automaticamente:

```bash
sudo reboot
```

Em outro computador, abra o painel, encontre a Pi em **Aparelhos** ou em
**Telas → TVs com Raspberry** e escolha a tela, por exemplo `tela-01`.
Sem tela escolhida, o aviso de seleção é esperado. Com tela escolhida, aguarde
o recebimento do conteúdo; o primeiro vídeo precisa ser baixado por inteiro.

## 4. Uso e manutenção no dia a dia

- A tela de cada aparelho se escolhe no painel. Não é preciso editar o serviço
  ou reinstalar a Pi para trocar a programação.
- **F11** sai da tela cheia; **F11** novamente volta.
- **Alt+F4** fecha o Chromium para manutenção. Quando ele encerra normalmente
  com código 0, o quiosque não reabre por cima do operador.
- O atalho **CorporTV na TV**, no menu, reabre a exibição. Reiniciar a Pi também
  faz o autostart abrir o quiosque.
- Uma falha do Chromium com saída diferente de zero provoca nova tentativa;
  falhas repetidas recebem espera progressiva de até 32 segundos.
- Mesmo fora da tela cheia, o Chromium só permite o CorporTV local. F11 não
  libera navegação para o painel remoto ou outros sites. Use outro computador
  para o painel e o terminal da Pi para o diagnóstico.
- O quiosque coloca o áudio da Pi em 100%. Ajuste o volume desejado no painel
  e no controle remoto da TV. Se a HDMI não foi detectada, ligue a TV e reinicie
  a Pi ou reabra o quiosque.

Os padrões são: registro do aparelho a cada 15 segundos, programação a cada
60 segundos e consulta da página do player a cada 600 segundos. O download é
limitado a 2 Mb/s por aparelho, com espera aleatória de até 90 segundos em ciclos
normais. Downloads longos e os limites do servidor podem aumentar a espera.

Para atualizar os arquivos instalados, repita o comando de preparo do painel.
Ele baixa a versão servida naquele momento e reinicia o agente. Depois, reinicie
a Pi para que a sessão gráfica e o quiosque usem os ajustes atualizados. Isso não
atualiza todo o Raspberry Pi OS. Preserve o cache: apagá-lo perde os downloads
e pode também apagar a identidade do aparelho.

Não coloque o cache em armazenamento descartável ou em um overlay que perca
escritas ao reiniciar. A reprodução local depende de arquivos persistentes.

## 5. Diagnóstico: siga esta ordem

Pare no primeiro passo que falhar e corrija essa parte antes de avançar. Os
comandos de rede desta seção são exemplos para o operador executar na Pi.

### 1 — A Pi está ligada?

Confira a fonte, o cabo USB-C, os LEDs, a entrada HDMI selecionada na TV e o cabo
na HDMI 0. Se houver terminal disponível:

```bash
uptime
```

Sem sinal de energia, confira alimentação antes de investigar o programa.
Tela preta com a Pi ligada também pode ser entrada errada da TV ou ausência
da sessão gráfica.

### 2 — A rede está conectada?

```bash
nmcli device status
nmcli connection show --active
ip -brief address
ip route
```

Procure uma interface conectada, endereço atribuído e rota até a rede do servidor.
Se a rede permitir ICMP, um teste adicional é:

```bash
ping -c 3 tv.exemplo.local
```

Ping bloqueado não prova que o servidor caiu. Continue com o teste HTTP.

### 3 — O nome do servidor resolve?

```bash
getent hosts tv.exemplo.local
nmcli -f GENERAL.DEVICE,IP4.DNS,IP4.DOMAIN device show
```

O primeiro comando deve retornar endereço. Use o nome completo configurado em
`/etc/corptv/agente.env`; não presuma que o nome curto resolve. O preparo só
acrescenta um sufixo de busca aos perfis existentes: não cria registros DNS.
Evite remendar cada Pi com uma entrada fixa em `/etc/hosts`.

### 4 — O servidor responde?

```bash
curl -fsS --max-time 15 http://tv.exemplo.local/health
```

Use protocolo e porta da instalação. Para separar falha de DNS de falha HTTP,
este exemplo mantém o nome no pedido. Digite o endereço conhecido do servidor
quando for solicitado; ele fica apenas na variável da sessão do terminal:

```bash
read -r -p 'Endereço IPv4 do servidor: ' IP_SERVIDOR
curl -fsS --max-time 15 --resolve "tv.exemplo.local:80:$IP_SERVIDOR" http://tv.exemplo.local/health
```

Se somente o segundo funcionar, investigue resolução de nomes. Se ambos
falharem, confira rota, porta, serviço e restrições de acesso com o responsável
pela instalação. Não altere o servidor a partir deste guia.

### 5 — O agente está no ar?

```bash
systemctl status corptv-agente
curl -s localhost:8080/status
journalctl -u corptv-agente -n 50 --no-pager
df -h /var/lib/corptv
```

O serviço deve estar ativo. O JSON de `/status` mostra `aparelho`, `tela`,
`servidor`, `limite_mbps`, `baixando`, `conteudos_prontos` e os arquivos com
`no_disco`. `tela: null` pede seleção no painel; arquivos ausentes pedem
investigação do download, da rede e do espaço no cartão. `baixando` indica um
ciclo de sincronização em andamento, não garante transferência de bytes naquele instante.

Para acompanhar ao vivo ou reiniciar somente o agente:

```bash
journalctl -u corptv-agente -f
sudo systemctl restart corptv-agente
```

Use Ctrl+C para sair do acompanhamento. O agente ativo não prova que o navegador
está exibindo: o registro do aparelho e o aviso de presença do player são separados.

### 6 — O navegador abriu?

```bash
journalctl -t corptv-quiosque -n 50 --no-pager
pgrep -af 'chromium|iniciar-quiosque'
```

O journal informa abertura, saída, tentativas de reabertura e seleção de áudio.
Depois de Alt+F4, a mensagem de encerramento com código 0 é esperada. Reabra pelo
atalho **CorporTV na TV**, na sessão gráfica. Se não abriu no boot, confira:

```bash
ls -l ~/.config/autostart/corptv-quiosque.desktop
```

Execute como o usuário do desktop. O agente pode estar funcionando antes de
alguém entrar no desktop, mas o navegador precisa da sessão gráfica.

### 7 — A temperatura está alta?

```bash
cat /sys/class/thermal/thermal_zone0/temp
awk '{printf "%.1f °C\n", $1 / 1000}' /sys/class/thermal/thermal_zone0/temp
```

`75000` significa **75 °C**. Confira ventilação, poeira, posição do case e calor
da TV. O código atual mede a temperatura por esse arquivo, com cache de 60 segundos,
e marca `limitada` a partir de 80 °C. A subtensão é uma leitura separada do sensor
`rpi_volt`; não é um histórico obtido por `vcgencmd`. Se um sensor faltar, sua
medição pode não aparecer. `/status` não inclui essas medições: elas são enviadas
no registro do aparelho para o painel.

## 6. Energia: reiniciar ou desligar

Para reiniciar durante manutenção:

```bash
sudo reboot
```

Para desligar antes de remover a fonte:

```bash
sudo shutdown -h now
```

Espere o sistema concluir o desligamento e cessar a atividade do cartão antes
de retirar a energia. Não use puxar a tomada como procedimento normal de
manutenção nem como teste de rotina: uma gravação interrompida pode danificar
o sistema ou o cache.

## 7. Como desfazer os ajustes

Faça a reversão no terminal local, com teclado, para não depender da conexão
que poderá ser alterada. Os comandos abaixo são de **desinstalação**, não de
diagnóstico. Se um arquivo já existia antes, restaure seu backup em vez de
simplesmente apagá-lo. Sem backup, não é possível recuperar exatamente configurações
anteriores, senhas de perfis substituídos ou prioridades antigas.

### Parar a abertura automática e o agente

Feche o Chromium com Alt+F4. No usuário do desktop, retire apenas os dois atalhos:

```bash
rm -f ~/.config/autostart/corptv-quiosque.desktop
rm -f ~/.local/share/applications/corptv-quiosque.desktop
sudo systemctl disable --now corptv-agente
```

Isso impede novas aberturas no login e para o agente. O cache permanece guardado.
Não há uma unidade `corptv-quiosque.service` para desabilitar, nem um usuário fixo
do agente para excluir.

### Retirar a configuração do watchdog

Para desfazer este passo, retire somente o arquivo do CorporTV e faça o systemd
reler sua configuração:

```bash
sudo rm -f /etc/systemd/system.conf.d/90-corptv-watchdog.conf
sudo systemctl daemon-reexec
```

Se esse arquivo já existia antes do preparo, restaure o backup em vez de apagá-lo
e execute o mesmo `daemon-reexec`. Outras configurações de watchdog do sistema
continuam valendo.

### Voltar as configurações do navegador e da sessão

Se foram criados por este preparo, remova os arquivos abaixo. Se foram
substituídos, restaure suas versões anteriores:

```bash
sudo rm -f /etc/chromium/policies/managed/corptv.json
sudo rm -f /etc/chromium.d/corptv
```

Feche todas as janelas do Chromium e abra novamente para aplicar. Isso retira as
políticas de navegação/tradução deste preparo e a opção global de chaveiro. Não
apague as pastas de políticas inteiras: podem conter ajustes de outros programas.

Para a regra do labwc, com o quiosque fechado:

- Se `rc.xml` já existia, restaure `rc.xml.antes-corptv` **somente se não houver
  mudanças posteriores que precise manter**. Caso contrário, edite o XML e remova
  apenas `windowRule identifier="corptv-tv"` e o comentário correspondente.
- Se o arquivo foi criado pelo quiosque e só contém essa regra, pode removê-lo.
  Preserve outras regras e preferências adicionadas depois.
- Saia e entre na sessão gráfica, ou reinicie. Se voltar a executar o quiosque,
  ele poderá recriar a regra; desative os atalhos antes.

Abra o arquivo, se precisar da remoção seletiva:

```bash
nano ~/.config/labwc/rc.xml
```

As correções em `~/.config/chromium/Default/Preferences` apenas normalizam flags
de encerramento. Não é necessário restaurar flags de falha. Para voltar ao perfil
exatamente anterior, feche o Chromium e restaure seu backup; não apague o perfil
inteiro para desfazer esses três indicadores.

O ajuste de áudio deve ser revertido nas preferências de som do desktop: escolha
a saída, o volume e o mudo anteriores. O quiosque não guarda esses valores antigos.
Sem iniciar o quiosque novamente, eles deixam de ser forçados a HDMI/100%.

Em X11, para voltar a habilitar protetor, apagamento e DPMS na sessão atual:

```bash
xset s on
xset s blank
xset +dpms
```

Esses comandos só se aplicam a X11. Para desfazer os ajustes persistentes de
apagamento e login automático, use `sudo raspi-config` e recoloque as opções
anteriores. Se a intenção for **desktop com senha e apagamento permitido**, use:

```bash
sudo raspi-config nonint do_blanking 0
sudo raspi-config nonint do_boot_behaviour B3
```

Isso escolhe essas opções, não restaura automaticamente um estado anterior
desconhecido. Se antes a Pi iniciava no terminal, escolha essa opção no
`raspi-config`. Reinicie depois de terminar a reversão.

### Voltar os ajustes de rede

Veja os nomes e UUIDs dos perfis e, para cada perfil alterado, retire somente o
sufixo que o preparo acrescentou. Exemplo para um perfil chamado `Conexao de teste`:

```bash
nmcli -f NAME,UUID,TYPE connection show
sudo nmcli connection modify "Conexao de teste" -ipv4.dns-search "exemplo.local"
```

Não retire um sufixo que já existia antes. Use UUID quando houver nomes repetidos.
Para um perfil cuja conexão automática foi desativada pelo preparo, restaure
`yes` apenas se esse era seu valor anterior:

```bash
sudo nmcli connection modify "Nome da rede" connection.autoconnect yes
```

Restaure o backup da configuração de economia de energia ou, se foi criada pelo
preparo, retire-a. Para ligar a economia imediatamente em `wlan0`, se `iw` estiver
instalado e esse for o ajuste desejado:

```bash
sudo rm -f /etc/NetworkManager/conf.d/99-corptv-wifi.conf
sudo iw dev wlan0 set power_save on
```

O padrão após remover o arquivo depende do sistema e dos perfis existentes. Para
aplicar os ajustes persistentes, reinicie a Pi ao concluir; não é preciso derrubar
o NetworkManager no meio da manutenção.

Se usou `corptv-wifi`, ele pode ter substituído um perfil anterior e zerado as
prioridades das outras redes Wi-Fi. Restaure os perfis pelo backup ou recrie-os
pelas configurações de rede, com suas credenciais corretas. Para remover somente
uma rede criada nessa etapa e retirar o comando auxiliar:

```bash
sudo nmcli connection delete "Nome da rede"
sudo rm -f /usr/local/bin/corptv-wifi
```

Apagar o comando não apaga perfis. Remover a rede em uso desconecta a Pi. As
prioridades anteriores precisam ser recolocadas individualmente, por exemplo
com `sudo nmcli connection modify "Outra rede" connection.autoconnect-priority 0`
se o valor anotado era zero.

### Retirar os arquivos instalados

Com o agente parado e desabilitado, para uma instalação nova sem arquivos
anteriores a restaurar:

```bash
sudo rm -f /etc/systemd/system/corptv-agente.service
sudo systemctl daemon-reload
sudo rm -f /opt/corptv-agente/agente.js
sudo rm -f /opt/corptv-agente/iniciar-quiosque.sh
sudo rm -f /etc/corptv/agente.env
```

`disable` já retirou o vínculo de inicialização automática. Preserve outros
arquivos nos diretórios compartilhados. O estado em `/var/lib/corptv` é mantido
deliberadamente: guarda identidade e conteúdo. Se a Pi for retirada de uso,
faça backup e remova essa área de estado somente depois de conferir o destino
real, incluindo eventual `/var/lib/private/corptv`. Apagá-la perde a identidade
e obriga uma instalação futura a baixar novamente o conteúdo.

O lock em `/tmp/corptv-quiosque-<UID>.lock` deixa de bloquear ao encerrar o
processo e não precisa ser removido manualmente. Temporários do preparo são
removidos na saída normal. Não limpe `/tmp` inteiro nem o journal do sistema:
eles também pertencem a outros programas.

Se Node.js foi instalado exclusivamente para este agente e nenhum outro programa
depende dele, pode removê-lo com `sudo apt remove nodejs`. Confira a lista de
remoções antes de confirmar. Não remova Node.js se ele já existia ou continua
sendo usado. O preparo não instala Chromium ou curl, portanto sua remoção não
faz parte da reversão do script.
