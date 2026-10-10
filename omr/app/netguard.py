"""공부방 와이파이(같은 내부망)에서 온 접속만 허용한다."""
import ipaddress
import socket

PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]


def local_ip():
    """이 컴퓨터의 내부망 주소 (예: 192.168.0.12). 실제로 데이터를 보내지는 않는다."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def build_networks(setting):
    nets = [ipaddress.ip_network("127.0.0.0/8"), ipaddress.ip_network("::1/128")]
    for item in setting or ["auto"]:
        if item == "auto":
            ip = local_ip()
            if ip and ipaddress.ip_address(ip).is_private:
                nets.append(ipaddress.ip_network(f"{ip}/24", strict=False))
            else:  # 주소를 못 찾으면 내부망 주소 전체만 허용
                nets.extend(ipaddress.ip_network(n) for n in PRIVATE)
        else:
            nets.append(ipaddress.ip_network(item, strict=False))
    return nets


def allowed(client_host, networks):
    try:
        ip = ipaddress.ip_address(client_host)
    except (ValueError, TypeError):
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip in n for n in networks if n.version == ip.version)
